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
 */
import { describeError, type Logger } from '../lib/log';
import { s, toValidator } from '../validation';
import { parseMessageEnvelope } from './events';
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
}

const MAX_RECONNECT_DELAY_MS = 30_000;

export function createSocketListener({
  openUrl,
  log,
  reconnectDelayMs = 1_000,
}: SocketListenerOptions): SlackListener {
  let socket: WebSocket | undefined;
  let stopped = false;
  let delay = reconnectDelayMs;
  let retry: ReturnType<typeof setTimeout> | undefined;
  /** Greeted by Slack and not closed since. */
  let live = false;
  let onMessage: (event: SlackMessageEvent) => void = () => undefined;
  let onConnected: () => void = () => undefined;

  /** Opens one connection; resolves on Slack's `hello`, rejects if it never comes. */
  async function connect(): Promise<void> {
    const url = await openUrl();
    return new Promise((resolve, reject) => {
      let greeted = false;
      const ws = new WebSocket(url);
      socket = ws;

      ws.addEventListener('message', (message) => {
        let frame;
        try {
          frame = frameValidator.parse(JSON.parse(String(message.data)));
        } catch {
          log.warn('slack sent an unreadable frame');
          return;
        }
        if (frame.envelope_id) ws.send(JSON.stringify({ envelope_id: frame.envelope_id }));

        switch (frame.type) {
          case 'hello':
            if ((frame.num_connections ?? 1) > 1) {
              // Slack hands each event to ONE of the app's connections. Another
              // process holding this token silently takes a share of the messages.
              log.warn('another process is connected with this app token', {
                connections: frame.num_connections,
              });
            }
            greeted = true;
            live = true;
            delay = reconnectDelayMs;
            resolve();
            onConnected();
            break;
          case 'disconnect':
            log.info('slack asked to reconnect', { reason: frame.reason });
            ws.close(1000);
            break;
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
    retry = setTimeout(() => {
      retry = undefined;
      connect()
        .then(() => log.info('slack socket reconnected'))
        .catch((error: unknown) => {
          log.warn('slack reconnect failed', { error: describeError(error) });
          delay = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
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
