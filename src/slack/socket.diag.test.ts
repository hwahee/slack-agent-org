/**
 * What the Socket Mode listener writes down for the diagnostics — against the
 * same kind of stand-in Slack as socket.test.ts. The listener's behaviour is
 * pinned there; here only the records and the snapshot are checked, plus the
 * one thing listening must never break: Slack's pings still get their pongs.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { Server, ServerWebSocket } from 'bun';

import { validateRecord } from '../diag/events';
import { createMemoryDiagnostics, type MemoryDiagnostics } from '../diag/memory';
import { silentLogger } from '../lib/log';
import { createSocketListener } from './socket';
import type { SlackListener } from './types';

interface FakeSlack {
  server: Server<undefined>;
  sockets: ServerWebSocket<undefined>[];
  pongs: number;
}

let slack: FakeSlack | undefined;
let listener: SlackListener | undefined;

afterEach(async () => {
  await listener?.stop();
  await slack?.server.stop(true);
  listener = undefined;
  slack = undefined;
});

function fakeSlack(hello: Record<string, unknown> = { type: 'hello', num_connections: 1 }) {
  const state = { sockets: [], pongs: 0 } as unknown as FakeSlack;
  state.server = Bun.serve({
    port: 0,
    fetch(request, srv) {
      return srv.upgrade(request) ? undefined : new Response(null, { status: 400 });
    },
    websocket: {
      open(ws) {
        state.sockets.push(ws);
        ws.send(JSON.stringify(hello));
      },
      message: () => undefined,
      pong() {
        state.pongs += 1;
      },
    },
  });
  slack = state;
  return state;
}

const SECRET_URL_PART = 'ticket=secret-ticket';

async function listen(fake: FakeSlack, diag: MemoryDiagnostics): Promise<void> {
  listener = createSocketListener({
    openUrl: () => Promise.resolve(`ws://127.0.0.1:${fake.server.port}/?${SECRET_URL_PART}`),
    log: silentLogger,
    reconnectDelayMs: 10,
    diag,
  });
  await listener.start(() => undefined);
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await Bun.sleep(5);
  expect(condition()).toBe(true);
}

describe('socket diagnostics', () => {
  test('a connection: url, open, hello with connection count and Slack debug info', async () => {
    const fake = fakeSlack({
      type: 'hello',
      num_connections: 1,
      debug_info: { host: 'applink-1', approximate_connection_time: 18060 },
    });
    const diag = createMemoryDiagnostics();
    await listen(fake, diag);

    expect(diag.records.map((r) => r.kind)).toEqual([
      'socket.url-requested',
      'socket.opened',
      'socket.hello',
    ]);
    expect(diag.of('socket.url-requested')[0]).toMatchObject({ conn: 1, ok: true });
    expect(diag.of('socket.hello')[0]).toMatchObject({
      conn: 1,
      numConnections: 1,
      debugHost: 'applink-1',
      approximateConnectionTime: 18060,
    });
    expect(diag.snapshot().sections.socket).toMatchObject({ conn: 1, live: true, readyState: 1 });
  });

  test('another connection on the same token shows in the hello record', async () => {
    const fake = fakeSlack({ type: 'hello', num_connections: 2 });
    const diag = createMemoryDiagnostics();
    await listen(fake, diag);
    expect(diag.of('socket.hello')[0]?.numConnections).toBe(2);
  });

  test("Slack's pings are counted, and still answered", async () => {
    const fake = fakeSlack();
    const diag = createMemoryDiagnostics();
    await listen(fake, diag);

    fake.sockets[0]?.ping('a');
    fake.sockets[0]?.ping('b');
    await until(() => diag.snapshot().sections.socket?.pingsReceived === 2);
    await until(() => fake.pongs === 2); // listening does not take over the pong
    const socket = diag.snapshot().sections.socket;
    expect(socket?.lastFrameType).toBe('ping');
    expect(socket?.lastPingAt).not.toBeNull();
    // Pings are kept in the snapshot, not one record each.
    expect(diag.records.some((r) => r.kind.includes('ping'))).toBe(false);
  });

  test('an envelope: redelivery counters and which message, never its text', async () => {
    const fake = fakeSlack();
    const diag = createMemoryDiagnostics();
    await listen(fake, diag);

    fake.sockets[0]?.send(
      JSON.stringify({
        type: 'events_api',
        envelope_id: 'env-9',
        retry_attempt: 1,
        retry_reason: 'timeout',
        payload: {
          event_id: 'Ev1',
          event_time: 1764000000,
          event: {
            type: 'message',
            channel: 'D1',
            channel_type: 'im',
            user: 'U0HUMAN',
            text: '비밀 이야기',
            ts: '1.0',
          },
        },
      }),
    );
    await until(() => diag.of('socket.envelope').length === 1);
    expect(diag.of('socket.envelope')[0]).toMatchObject({
      conn: 1,
      type: 'events_api',
      envelopeId: 'env-9',
      retryAttempt: 1,
      retryReason: 'timeout',
      eventId: 'Ev1',
      eventTime: 1764000000,
      eventType: 'message',
      channel: 'D1',
      channelType: 'im',
      ts: '1.0',
    });
    expect(JSON.stringify(diag.records)).not.toContain('비밀');
  });

  test('a dropped connection: closed, reconnect scheduled, a new connection number', async () => {
    const fake = fakeSlack();
    const diag = createMemoryDiagnostics();
    await listen(fake, diag);

    fake.sockets[0]?.close(1011, 'gone');
    await until(() => diag.of('socket.hello').length === 2);

    expect(diag.of('socket.closed')[0]).toMatchObject({
      conn: 1,
      code: 1011,
      greeted: true,
    });
    expect(diag.of('socket.reconnect-scheduled')[0]).toMatchObject({ delayMs: 10, attempt: 1 });
    expect(diag.of('socket.hello')[1]?.conn).toBe(2);
    expect(diag.snapshot().sections.socket).toMatchObject({ conn: 2, reconnects: 1 });
  });

  test("Slack's disconnect request is recorded with its reason", async () => {
    const fake = fakeSlack();
    const diag = createMemoryDiagnostics();
    await listen(fake, diag);

    fake.sockets[0]?.send(
      JSON.stringify({
        type: 'disconnect',
        reason: 'refresh_requested',
        debug_info: { host: 'applink-1' },
      }),
    );
    await until(() => diag.of('socket.hello').length === 2);
    expect(diag.of('socket.disconnect-requested')[0]).toMatchObject({
      conn: 1,
      reason: 'refresh_requested',
      debugHost: 'applink-1',
    });
  });

  test('a refused URL request is recorded without the token or the URL', async () => {
    const diag = createMemoryDiagnostics();
    listener = createSocketListener({
      openUrl: () => Promise.reject(new Error('apps.connections.open failed: invalid_auth')),
      log: silentLogger,
      diag,
    });
    await expect(listener.start(() => undefined)).rejects.toThrow('invalid_auth');
    expect(diag.of('socket.url-requested')[0]).toMatchObject({
      conn: 1,
      ok: false,
      error: 'apps.connections.open failed: invalid_auth',
    });
  });

  test('every record fits the contract and none carries the socket URL', async () => {
    const fake = fakeSlack();
    const diag = createMemoryDiagnostics();
    await listen(fake, diag);
    fake.sockets[0]?.send('not json');
    fake.sockets[0]?.close(1011);
    await until(() => diag.of('socket.hello').length === 2);

    expect(diag.of('socket.frame-unreadable')).toHaveLength(1);
    for (const record of diag.records) expect(validateRecord(record)).toEqual({ ok: true });
    expect(JSON.stringify(diag.records)).not.toContain(SECRET_URL_PART);
  });
});
