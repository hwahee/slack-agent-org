/**
 * The Socket Mode listener against a stand-in Slack: a local WebSocket server
 * that says hello, sends envelopes, records acks, and asks for reconnects.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { Server, ServerWebSocket } from 'bun';

import { silentLogger } from '../lib/log';
import { createSocketListener } from './socket';
import type { SlackListener, SlackMessageEvent } from './types';

interface FakeSlack {
  server: Server<undefined>;
  sockets: ServerWebSocket<undefined>[];
  acks: string[];
  connections: number;
}

let slack: FakeSlack | undefined;
let listener: SlackListener | undefined;

afterEach(async () => {
  await listener?.stop();
  await slack?.server.stop(true);
  listener = undefined;
  slack = undefined;
});

function fakeSlack(): FakeSlack {
  const state = { sockets: [], acks: [], connections: 0 } as unknown as FakeSlack;
  state.server = Bun.serve({
    port: 0,
    fetch(request, srv) {
      return srv.upgrade(request) ? undefined : new Response(null, { status: 400 });
    },
    websocket: {
      open(ws) {
        state.connections += 1;
        state.sockets.push(ws);
        ws.send(JSON.stringify({ type: 'hello', num_connections: 1 }));
      },
      message(_ws, data) {
        const frame = JSON.parse(String(data)) as { envelope_id: string };
        state.acks.push(frame.envelope_id);
      },
    },
  });
  slack = state;
  return state;
}

function listen(
  fake: FakeSlack,
  onMessage: (event: SlackMessageEvent) => void,
  onConnected?: () => void,
) {
  listener = createSocketListener({
    openUrl: () => Promise.resolve(`ws://127.0.0.1:${fake.server.port}`),
    log: silentLogger,
    reconnectDelayMs: 10,
  });
  return listener.start(onMessage, onConnected);
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await Bun.sleep(5);
  expect(condition()).toBe(true);
}

const dm = {
  type: 'events_api',
  envelope_id: 'env-1',
  payload: {
    event: {
      type: 'message',
      channel: 'D1',
      channel_type: 'im',
      user: 'U0HUMAN',
      text: '안녕',
      ts: '1.0',
    },
  },
};

describe('socket listener', () => {
  test('acknowledges an envelope and hands its message on', async () => {
    const fake = fakeSlack();
    const heard: SlackMessageEvent[] = [];
    await listen(fake, (event) => heard.push(event));

    fake.sockets[0]?.send(JSON.stringify(dm));
    await until(() => heard.length === 1);
    expect(fake.acks).toEqual(['env-1']);
    expect(heard[0]).toMatchObject({ channel: 'D1', text: '안녕' });
  });

  test('stays connected (no client-side ping that drops the socket)', async () => {
    const fake = fakeSlack();
    await listen(fake, () => undefined);
    await Bun.sleep(100);
    expect(fake.connections).toBe(1);
  });

  test('reconnects when Slack asks to, and keeps listening', async () => {
    const fake = fakeSlack();
    const heard: SlackMessageEvent[] = [];
    await listen(fake, (event) => heard.push(event));

    fake.sockets[0]?.send(JSON.stringify({ type: 'disconnect', reason: 'refresh_requested' }));
    await until(() => fake.connections === 2);

    fake.sockets[1]?.send(JSON.stringify({ ...dm, envelope_id: 'env-2' }));
    await until(() => heard.length === 1);
  });

  test('reconnects when the connection drops', async () => {
    const fake = fakeSlack();
    await listen(fake, () => undefined);
    fake.sockets[0]?.close(1011);
    await until(() => fake.connections === 2);
  });

  test('says whether it is connected, and announces every (re)connection', async () => {
    const fake = fakeSlack();
    let connections = 0;
    await listen(
      fake,
      () => undefined,
      () => (connections += 1),
    );
    expect(listener?.connected()).toBe(true);
    expect(connections).toBe(1);

    fake.sockets[0]?.close(1011);
    await until(() => connections === 2);
    expect(listener?.connected()).toBe(true);

    await listener?.stop();
    expect(listener?.connected()).toBe(false);
  });

  test('warns when another process shares the app token', async () => {
    const fake = fakeSlack();
    const warnings: string[] = [];
    listener = createSocketListener({
      openUrl: () => Promise.resolve(`ws://127.0.0.1:${fake.server.port}`),
      log: { ...silentLogger, warn: (message) => warnings.push(message) },
    });
    await listener.start(() => undefined);
    expect(warnings).toEqual([]);

    fake.sockets[0]?.send(JSON.stringify({ type: 'hello', num_connections: 2 }));
    await until(() => warnings.length === 1);
    expect(warnings[0]).toContain('another process');
  });

  test('stop closes for good', async () => {
    const fake = fakeSlack();
    await listen(fake, () => undefined);
    await listener?.stop();
    await Bun.sleep(50);
    expect(fake.connections).toBe(1);
  });

  test('start fails when Slack refuses the token', async () => {
    listener = createSocketListener({
      openUrl: () => Promise.reject(new Error('apps.connections.open failed: invalid_auth')),
      log: silentLogger,
    });
    await expect(listener.start(() => undefined)).rejects.toThrow('invalid_auth');
  });
});
