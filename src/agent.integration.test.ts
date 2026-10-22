/**
 * The whole agent, wired by the real container, with only the outside world
 * replaced: Slack by a memory listener, the screen by a memory desk, the
 * model by a script that works the desk through the real MCP tool server —
 * the same path `claude -p` takes.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { loadConfig } from './config';
import { createContainer, type Container } from './container';
import { createMemoryDesk } from './desk/memory';
import type { Engine, EngineTurn, Judge } from './engine/types';
import { silentLogger } from './lib/log';
import { createMemoryDirectory, createMemoryHistory, createMemoryListener } from './slack/memory';
import type { StatusLook } from './slack/types';
import { createMemoryStateStore } from './state/memory';

const AGENT = 'U0AGENT';
const HUMAN = 'U0HUMAN';

let container: Container | undefined;

/** A judge that never thinks the agent should chime in. */
const quietJudge: Judge = {
  ask: () => Promise.resolve({ text: '{"respond": false, "reason": "잡담"}' }),
};

const config = (env: Record<string, string> = {}) =>
  loadConfig({
    AGENT_NAME: '클로이',
    AGENT_SLACK_USER_ID: AGENT,
    HUMAN_SLACK_USER_IDS: HUMAN,
    SLACK_APP_TOKEN: 'xapp-test',
    SLACK_READ_TOKEN: 'xoxp-test',
    ...env,
  });

afterEach(async () => {
  await container?.triage()?.stop();
  await container?.toolServer().stop();
  container = undefined;
});

describe('agent', () => {
  test('hears a DM, works the desk to reply, and ignores its own message', async () => {
    const listener = createMemoryListener();
    const desk = createMemoryDesk();
    const stop = new AbortController();
    const turns: EngineTurn[] = [];

    /** Plays the model: answers on screen, the way the system prompt says to. */
    const engine: Engine = {
      async run(turn) {
        turns.push(turn);
        if (!container) throw new Error('container not built yet');
        const { url, token } = container.toolServer();
        const client = new Client({ name: 'scripted-model', version: '1.0.0' });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(url), {
            requestInit: { headers: { Authorization: `Bearer ${token}` } },
          }),
        );
        const use = (name: string, args: Record<string, unknown> = {}) =>
          client.callTool({ name, arguments: args });

        await use('screenshot');
        await use('key', { combo: 'cmd+k' });
        await use('type', { text: '지훈' });
        await use('key', { combo: 'enter' });
        await use('click', { x: 700, y: 820 });
        await use('type', { text: '네, 3시에 가능합니다.' });
        await use('key', { combo: 'enter' });
        await client.close();

        // The sent message comes back through the ears, like everyone's does.
        listener.emit({
          channel: 'D1',
          channelType: 'im',
          user: AGENT,
          text: '네, 3시에 가능합니다.',
          ts: '2.0',
        });
        stop.abort();
        return { sessionId: 'session-1', ok: true, summary: '답장함' };
      },
    };

    container = createContainer(config(), {
      log: silentLogger,
      listener,
      directory: createMemoryDirectory({
        users: { [HUMAN]: '지훈', [AGENT]: '클로이' },
        channels: { C1: 'team' },
      }),
      desk,
      state: createMemoryStateStore(),
      engine,
      judge: quietJudge,
    });

    const intake = container.intake();
    await container.listener().start((event) => void intake(event));
    listener.emit({
      channel: 'C1',
      channelType: 'channel',
      user: HUMAN,
      text: '점심 뭐 먹지',
      ts: '0.5',
    });
    listener.emit({
      channel: 'D1',
      channelType: 'im',
      user: HUMAN,
      text: '오늘 3시 미팅 돼요?',
      ts: '1.0',
    });
    await Bun.sleep(0); // intake resolves names asynchronously
    await container.triage()?.flush(); // the channel chatter gets its glance: stay quiet

    await container.runtime().run(stop.signal);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.prompt).toContain('DM · 지훈');
    expect(turns[0]?.prompt).toContain('오늘 3시 미팅 돼요?');
    expect(turns[0]?.prompt).not.toContain('점심'); // not addressed to the agent
    expect(desk.actions).toEqual([
      'screenshot',
      'key cmd+k',
      'type 지훈',
      'key return',
      'click 700,820 left x1',
      'type 네, 3시에 가능합니다.',
      'key return',
    ]);
    expect(container.inbox().size).toBe(0); // its own reply did not come back as work
    // What was said is remembered for the next turn: the human's question, the agent's
    // own reply, and the channel chatter it was not asked about — and the turn's note.
    expect(await container.state().memoryOf('D1')).toEqual({
      remarks: [
        { ts: '1.0', userName: '지훈', text: '오늘 3시 미팅 돼요?', own: false },
        { ts: '2.0', userName: '클로이', text: '네, 3시에 가능합니다.', own: true },
      ],
      notes: [{ at: expect.any(String) as string, text: '답장함' }],
    });
    expect((await container.state().memoryOf('C1')).remarks.map((r) => r.text)).toEqual([
      '점심 뭐 먹지',
    ]);
  });

  test('answers an overheard channel question when triage says it should', async () => {
    const listener = createMemoryListener();
    const stop = new AbortController();
    const turns: EngineTurn[] = [];
    const judge: Judge = {
      ask: () =>
        Promise.resolve({
          text: '{"respond": true, "reason": "모두에게 던진 질문이고 답이 없음"}',
        }),
    };
    const engine: Engine = {
      run(turn) {
        turns.push(turn);
        stop.abort();
        return Promise.resolve({ sessionId: 'session-1', ok: true, summary: '스레드에 답함' });
      },
    };
    container = createContainer(config({ TRIAGE_WAIT_SECONDS: '0' }), {
      log: silentLogger,
      listener,
      directory: createMemoryDirectory({ users: { [HUMAN]: '지훈' }, channels: { C1: 'team' } }),
      desk: createMemoryDesk(),
      state: createMemoryStateStore(),
      engine,
      judge,
    });

    const intake = container.intake();
    await container.listener().start((event) => void intake(event));
    listener.emit({
      channel: 'C1',
      channelType: 'channel',
      user: HUMAN,
      text: '배포 어디까지 됐는지 아는 사람?',
      ts: '1.0',
    });
    await Bun.sleep(0);
    await container.triage()?.flush();

    await container.runtime().run(stop.signal);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.prompt).toContain('#team · 지훈');
    expect(turns[0]?.prompt).toContain('나를 부르지 않은 채널 글');
    expect(turns[0]?.prompt).toContain('모두에게 던진 질문이고 답이 없음');
  });

  test('on reconnecting, answers a DM sent while nobody was listening, and shows it is fine', async () => {
    const listener = createMemoryListener();
    const history = createMemoryHistory();
    const state = createMemoryStateStore();
    const shown: StatusLook[] = [];
    const stop = new AbortController();
    const turns: EngineTurn[] = [];
    const now = Date.now();
    await state.setHeardUntil(new Date(now - 10 * 60_000).toISOString());
    history.post({
      channel: 'D1',
      channelType: 'im',
      user: HUMAN,
      text: '자리 비운 사이에 보낸 질문',
      ts: ((now - 5 * 60_000) / 1000).toFixed(6),
    });
    container = createContainer(config(), {
      log: silentLogger,
      listener,
      history,
      directory: createMemoryDirectory({ users: { [HUMAN]: '지훈' } }),
      status: {
        set: (look) => {
          shown.push(look);
          return Promise.resolve();
        },
      },
      desk: createMemoryDesk(),
      state,
      engine: {
        run(turn) {
          turns.push(turn);
          stop.abort();
          return Promise.resolve({ sessionId: 'session-1', ok: true, summary: '늦은 답장함' });
        },
      },
      judge: quietJudge,
    });

    const intake = container.intake();
    const catchup = container.catchup();
    await container.listener().start((event) => void intake(event));
    listener.setConnected(false);
    await container.heartbeat().beat(); // the ears are down: the time is not moved
    expect(shown).toEqual([]);

    await catchup?.run(); // what the reconnect hook does
    listener.setConnected(true);
    await container.heartbeat().beat();
    await container.runtime().run(stop.signal);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.prompt).toContain('자리 비운 사이에 보낸 질문');
    expect(turns[0]?.prompt).toContain('늦게 확인');
    expect(shown).toHaveLength(1);
    expect(shown[0]?.text).toMatch(/^근무 중 · \d{2}:\d{2} 확인$/);
  });
});
