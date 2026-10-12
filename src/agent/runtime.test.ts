import { describe, expect, test } from 'bun:test';

import type { Engine, EngineResult, EngineTurn } from '../engine/types';
import { Inbox } from '../inbox/inbox';
import { silentLogger } from '../lib/log';
import { createMemoryStateStore } from '../state/memory';
import { inboxMessage } from '../testing/fixtures';
import { messagesPrompt, resumePrompt, systemPrompt } from './prompts';
import { AgentRuntime } from './runtime';

/** An engine that plays a script, one step per turn, and records what it was asked. */
function scriptedEngine(
  steps: ((turn: EngineTurn) => void | Promise<void>)[],
  onDone: () => void,
): Engine & { turns: EngineTurn[] } {
  const turns: EngineTurn[] = [];
  return {
    turns,
    async run(turn): Promise<EngineResult> {
      turns.push(turn);
      const step = steps[turns.length - 1];
      if (step) await step(turn);
      if (turns.length >= steps.length) onDone();
      return { sessionId: turn.sessionId ?? `session-${turns.length}`, ok: true, summary: 'done' };
    },
  };
}

function setup(steps: ((turn: EngineTurn) => void | Promise<void>)[]) {
  const inbox = new Inbox();
  const state = createMemoryStateStore();
  const controller = new AbortController();
  const engine = scriptedEngine(steps, () => controller.abort());
  const runtime = new AgentRuntime({
    inbox,
    engine,
    state,
    timeZone: 'Asia/Seoul',
    log: silentLogger,
    failureBackoffMs: 0,
  });
  return { inbox, state, engine, runtime, run: () => runtime.run(controller.signal) };
}

describe('AgentRuntime', () => {
  test('gives each conversation one turn with all its waiting messages, in its own session', async () => {
    const { inbox, state, engine, run } = setup([() => undefined, () => undefined]);
    inbox.push(inboxMessage('1.0', 'A', '첫 번째'));
    inbox.push(inboxMessage('2.0', 'B', '다른 대화'));
    inbox.push(inboxMessage('3.0', 'A', '두 번째'));
    await state.saveSession('B', 'b-session');

    await run();

    expect(engine.turns).toHaveLength(2);
    expect(engine.turns[0]?.prompt).toContain('첫 번째');
    expect(engine.turns[0]?.prompt).toContain('두 번째');
    expect(engine.turns[0]?.sessionId).toBeUndefined();
    expect(await state.sessionOf('A')).toBe('session-1');
    expect(engine.turns[1]?.sessionId).toBe('b-session');
  });

  test('a message that arrives mid-turn waits for the turn to end', async () => {
    const { inbox, engine, run } = setup([
      () => inbox.push(inboxMessage('2.0', 'B', '급한 질문')),
      () => undefined,
    ]);
    inbox.push(inboxMessage('1.0', 'A', '긴 작업'));
    await run();
    expect(engine.turns.map((t) => t.prompt.includes('급한 질문'))).toEqual([false, true]);
  });

  test('a task paused at a safe point resumes after the waiting messages, in its own session', async () => {
    const { inbox, engine, runtime, run } = setup([
      () => {
        inbox.push(inboxMessage('2.0', 'B', '급한 질문'));
        expect(runtime.requestYield('표 3개 중 2개 정리함. 다음: 세 번째 표')).toBe(true);
      },
      () => undefined,
      () => undefined,
    ]);
    inbox.push(inboxMessage('1.0', 'A', '긴 작업'));
    await run();

    expect(engine.turns[1]?.prompt).toContain('급한 질문');
    expect(engine.turns[2]?.prompt).toBe(resumePrompt('표 3개 중 2개 정리함. 다음: 세 번째 표'));
    expect(engine.turns[2]?.sessionId).toBe('session-1');
  });

  test('nothing to pause between turns', () => {
    const { runtime } = setup([]);
    expect(runtime.requestYield('note')).toBe(false);
  });

  test('a failed turn is logged and the loop goes on', async () => {
    const { inbox, engine, run } = setup([
      () => {
        throw new Error('not logged in');
      },
      () => undefined,
    ]);
    inbox.push(inboxMessage('1.0', 'A'));
    inbox.push(inboxMessage('2.0', 'B'));
    await run();
    expect(engine.turns).toHaveLength(2);
  });

  test('shutdown waits for the turn in progress, and the queue survives', async () => {
    const { inbox, state, runtime, run } = setup([
      async () => {
        inbox.push(inboxMessage('2.0', 'B', '나중에'));
        runtime.requestYield('반쯤 함');
        await Bun.sleep(5);
      },
    ]);
    inbox.push(inboxMessage('1.0', 'A'));
    await run();

    const saved = await state.loadQueue();
    expect(saved.pending.map((m) => m.id)).toEqual(['B:2.0']);
    expect(saved.suspended).toEqual([{ conversation: 'A', note: '반쯤 함' }]);

    const next = setup([]);
    next.runtime.restore(saved);
    expect(next.runtime.snapshot()).toEqual(saved);
  });
});

describe('prompts', () => {
  test('the system prompt names the agent and the tools the protocol relies on', () => {
    const prompt = systemPrompt({
      agentName: '클로이',
      agentSlackUserId: 'U0AGENT',
      slackClient: 'desktop',
      timeZone: 'Asia/Seoul',
    });
    expect(prompt).toContain('당신은 클로이입니다');
    expect(prompt).toContain('<@U0AGENT>');
    for (const tool of [
      'screenshot',
      'read_screen',
      'click',
      'type',
      'key',
      'inbox_peek',
      'inbox_take',
      'inbox_yield',
    ]) {
      expect(prompt).toContain(tool);
    }
  });

  test('a turn prompt shows each message like a notification', () => {
    const prompt = messagesPrompt(
      [inboxMessage('1760054400.000100', 'D1', '내일 회의 몇 시죠?')],
      'Asia/Seoul',
    );
    expect(prompt).toContain('새 Slack 메시지 1건');
    expect(prompt).toContain('[D1:1760054400.000100] DM · 지훈 · 10. 10. 오전 9:00');
    expect(prompt).toContain('  내일 회의 몇 시죠?');
  });
});
