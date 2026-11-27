/**
 * Socket Mode listener — the agent's ears.
 *
 * Holds only the app-level token (`xapp-`). It asks Slack for a WebSocket URL
 * (`apps.connections.open`), connects outbound, acknowledges every envelope at
 * once (Slack redelivers unacknowledged ones) and hands message events on.
 * Listening is always on and always light; whether a message interrupts the
 * work in progress is decided later, by the agent, at a safe point
 * (CLAUDE.md: cooperative interruption).
 *
 * Bun's built-in WebSocket rather than @slack/socket-mode: that client keeps
 * the connection alive with a Node-only ping (undici's `ping`), which Bun does
 * not have — every connection dropped two seconds after it opened. Here the
 * protocol fits on one screen, and the WebSocket answers Slack's pings itself.
 *
 * Protocol (https://docs.slack.dev/apis/events-api/using-socket-mode):
 *   hello                → connected
 *   events_api, …        → ack `{ envelope_id }`, then handle the payload
 *   disconnect           → Slack is about to close (refresh, server moving); reconnect
 *
 * Diagnostics (`diag`) only watch: every frame, ping, close and reconnect is
 * written down, and nothing about when or how the listener connects changes.
 */
import { noopDiagnostics, type Diagnostics } from '../diag/types';
import { describeError, type Logger } from '../lib/log';
import { s, toValidator } from '../validation';
import { parseMessageEnvelope, readDebugInfo, readEnvelopeMeta } from './events';
import type { SlackListener, SlackMessageEvent } from './types';

const openResponseValidator = toValidator(
  s.object({ ok: s.boolean(), url: s.optional(s.string()), error: s.optional(s.string()) }),
);

const frameValidator = toValidator(
  s.looseObject({
    type: s.string(),
    envelope_id: s.optional(s.string()),
    reason: s.optional(s.string()),
    num_connections: s.optional(s.number()),
    payload: s.optional(s.unknown()),
  }),
);

/** Asks Slack for a fresh WebSocket URL (each URL works once). */
export function openSocketUrl(appToken: string): () => Promise<string> {
  return async () => {
    const response = await fetch('https://slack.com/api/apps.connections.open', {
      method: 'POST',
      headers: { Authorization: `Bearer ${appToken}` },
    });
    const body = openResponseValidator.parse(await response.json());
    if (!body.ok || !body.url) {
      throw new Error(`apps.connections.open failed: ${body.error ?? response.status}`);
    }
    return body.url;
  };
}

export interface SocketListenerOptions {
  /** Where to connect next; production asks Slack (`openSocketUrl`). */
  readonly openUrl: () => Promise<string>;
  readonly log: Logger;
  /** First reconnect delay; doubles per failed attempt up to 30 s. */
  readonly reconnectDelayMs?: number;
  /** Where the connection's life is written down (docs/diagnostics.md). Observes only. */
  readonly diag?: Diagnostics;
}

const MAX_RECONNECT_DELAY_MS = 30_000;

/** What the diagnostics know about the connection; none of it steers the listener. */
interface Observed {
  /** Connection attempts so far (the current or last one's number). */
  conn: number;
  /** Failed attempts in a row since the last hello. */
  attempt: number;
  hellos: number;
  requestedAt: number;
  connectedAt: Date | undefined;
  lastFrameAt: Date | undefined;
  lastFrameType: string | undefined;
  framesReceived: number;
  pingsReceived: number;
  lastPingAt: Date | undefined;
  lastEnvelopeAt: Date | undefined;
}

const iso = (date: Date | undefined) => date?.toISOString() ?? null;

export function createSocketListener({
  openUrl,
  log,
  reconnectDelayMs = 1_000,
  diag = noopDiagnostics,
}: SocketListenerOptions): SlackListener {
  let socket: WebSocket | undefined;
  let stopped = false;
  let delay = reconnectDelayMs;
  let retry: ReturnType<typeof setTimeout> | undefined;
  /** Greeted by Slack and not closed since. */
  let live = false;
  let onMessage: (event: SlackMessageEvent) => void = () => undefined;
  let onConnected: () => void = () => undefined;

  const seen: Observed = {
    conn: 0,
    attempt: 0,
    hellos: 0,
    requestedAt: 0,
    connectedAt: undefined,
    lastFrameAt: undefined,
    lastFrameType: undefined,
    framesReceived: 0,
    pingsReceived: 0,
    lastPingAt: undefined,
    lastEnvelopeAt: undefined,
  };
  diag.section('socket', () => ({
    conn: seen.conn,
    live,
    readyState: socket?.readyState ?? null,
    bufferedAmount: socket?.bufferedAmount ?? null,
    connectedAt: iso(seen.connectedAt),
    lastFrameAt: iso(seen.lastFrameAt),
    lastFrameType: seen.lastFrameType ?? null,
    framesReceived: seen.framesReceived,
    pingsReceived: seen.pingsReceived,
    lastPingAt: iso(seen.lastPingAt),
    lastEnvelopeAt: iso(seen.lastEnvelopeAt),
    reconnects: Math.max(0, seen.hellos - 1),
  }));

  /** Opens one connection; resolves on Slack's `hello`, rejects if it never comes. */
  async function connect(): Promise<void> {
    const conn = (seen.conn += 1);
    seen.requestedAt = performance.now();
    let url: string;
    try {
      url = await openUrl();
    } catch (error) {
      diag.record('socket.url-requested', {
        conn,
        ok: false,
        ms: elapsed(seen.requestedAt),
        error: describeError(error),
      });
      throw error;
    }
    // The URL carries a one-time ticket: it is never written down.
    diag.record('socket.url-requested', { conn, ok: true, ms: elapsed(seen.requestedAt) });
    return new Promise((resolve, reject) => {
      let greeted = false;
      const ws = new WebSocket(url);
      socket = ws;
      let openedAt: number | undefined;

      ws.addEventListener('open', () => {
        openedAt = performance.now();
        diag.record('socket.opened', { conn, msSinceRequest: elapsed(seen.requestedAt) });
      });

      // Bun reports Slack's WebSocket pings and still answers them by itself;
      // listening only counts them.
      ws.addEventListener('ping', () => {
        const now = new Date();
        seen.pingsReceived += 1;
        seen.lastPingAt = now;
        seen.lastFrameAt = now;
        seen.lastFrameType = 'ping';
      });

      ws.addEventListener('error', (event) => {
        const message = (event as { message?: unknown }).message;
        diag.record('socket.error', {
          conn,
          message: typeof message === 'string' && message ? message : 'websocket error',
        });
      });

      ws.addEventListener('message', (message) => {
        const now = new Date();
        seen.lastFrameAt = now;
        seen.framesReceived += 1;
        let raw: unknown;
        let frame;
        try {
          raw = JSON.parse(String(message.data));
          frame = frameValidator.parse(raw);
        } catch {
          seen.lastFrameType = 'unreadable';
          log.warn('slack sent an unreadable frame');
          diag.record('socket.frame-unreadable', { conn, bytes: String(message.data).length });
          return;
        }
        seen.lastFrameType = frame.type;
        if (frame.envelope_id) ws.send(JSON.stringify({ envelope_id: frame.envelope_id }));
        if (frame.envelope_id) {
          seen.lastEnvelopeAt = now;
          diag.record('socket.envelope', {
            conn,
            type: frame.type,
            envelopeId: frame.envelope_id,
            ...readEnvelopeMeta(raw),
          });
        }

        switch (frame.type) {
          case 'hello':
            if ((frame.num_connections ?? 1) > 1) {
              // Slack hands each event to ONE of the app's connections. Another
              // process holding this token silently takes a share of the messages.
              log.warn('another process is connected with this app token', {
                connections: frame.num_connections,
              });
            }
            diag.record('socket.hello', {
              conn,
              numConnections: frame.num_connections ?? null,
              helloAfterMs: elapsed(seen.requestedAt),
              ...readDebugInfo(raw),
            });
            seen.hellos += 1;
            seen.attempt = 0;
            seen.connectedAt = now;
            greeted = true;
            live = true;
            delay = reconnectDelayMs;
            resolve();
            onConnected();
            break;
          case 'disconnect': {
            log.info('slack asked to reconnect', { reason: frame.reason });
            const { debugHost } = readDebugInfo(raw);
            diag.record('socket.disconnect-requested', {
              conn,
              ...(frame.reason !== undefined && { reason: frame.reason }),
              ...(debugHost !== undefined && { debugHost }),
            });
            ws.close(1000);
            break;
          }
          case 'events_api': {
            const event = parseMessageEnvelope(frame.payload);
            if (event) onMessage(event);
            else log.debug('slack event ignored (not a message)', { payload: frame.payload });
            break;
          }
          default:
            log.debug('slack frame', { type: frame.type });
        }
      });

      ws.addEventListener('close', (closed) => {
        log.info('slack socket closed', { code: closed.code, reason: closed.reason });
        diag.record('socket.closed', {
          conn,
          code: closed.code,
          reason: closed.reason,
          wasClean: closed.wasClean,
          greeted,
          livedMs: openedAt === undefined ? 0 : elapsed(openedAt),
          lastFrameAgoMs:
            seen.lastFrameAt === undefined ? null : Date.now() - seen.lastFrameAt.getTime(),
        });
        if (socket === ws) {
          socket = undefined;
          live = false;
        }
        if (!greeted) reject(new Error(`slack closed the socket before hello (${closed.code})`));
        if (!stopped) scheduleReconnect();
      });
    });
  }

  function scheduleReconnect(): void {
    if (retry) return;
    log.info('slack socket closed; reconnecting', { inMs: delay });
    seen.attempt += 1;
    diag.record('socket.reconnect-scheduled', { delayMs: delay, attempt: seen.attempt });
    retry = setTimeout(() => {
      retry = undefined;
      connect()
        .then(() => log.info('slack socket reconnected'))
        .catch((error: unknown) => {
          log.warn('slack reconnect failed', { error: describeError(error) });
          delay = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
          diag.record('socket.reconnect-failed', {
            error: describeError(error),
            nextDelayMs: delay,
          });
          if (!stopped && !socket) scheduleReconnect();
        });
    }, delay);
  }

  return {
    async start(handleMessage, handleConnected) {
      stopped = false;
      onMessage = handleMessage;
      onConnected = handleConnected ?? (() => undefined);
      await connect();
      log.info('slack socket connected');
    },

    connected: () => live,

    stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      retry = undefined;
      socket?.close(1000);
      socket = undefined;
      live = false;
      return Promise.resolve();
    },
  };
}

function elapsed(since: number): number {
  return Math.round(performance.now() - since);
}
