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
      return { sessionId: `session-${turns.length}`, ok: true, summary: `done ${turns.length}` };
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
  test('gives each conversation one turn with all its waiting messages, and what it remembers', async () => {
    const { inbox, state, engine, run } = setup([() => undefined, () => undefined]);
    inbox.push(inboxMessage('1.0', 'A', '첫 번째'));
    inbox.push(inboxMessage('2.0', 'B', '다른 대화'));
    inbox.push(inboxMessage('3.0', 'A', '두 번째'));
    await state.remember('B', { ts: '0.5', userName: '지훈', text: '어제 얘기한 표', own: false });
    await state.addNote('B', {
      at: '2026-10-12T00:00:00.000Z',
      text: '표 초안을 ~/표.numbers에 저장함',
    });

    await run();

    expect(engine.turns).toHaveLength(2);
    expect(engine.turns[0]?.prompt).toContain('첫 번째');
    expect(engine.turns[0]?.prompt).toContain('두 번째');
    expect(engine.turns[0]?.prompt).not.toContain('지난 작업 기록');
    expect(engine.turns[1]?.prompt).toContain('지훈: 어제 얘기한 표');
    expect(engine.turns[1]?.prompt).toContain('표 초안을 ~/표.numbers에 저장함');
    // The engine's closing words become the conversation's note for next time.
    expect((await state.memoryOf('A')).notes.map((n) => n.text)).toEqual(['done 1']);
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

  test('a task paused at a safe point resumes after the waiting messages, with its notes', async () => {
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
    expect(engine.turns[2]?.prompt).toContain('표 3개 중 2개 정리함. 다음: 세 번째 표');
    expect(engine.turns[2]?.prompt).toContain('done 1'); // the note from the paused turn
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

  test('a turn is told what was said before, newest kept, without repeating the new message', () => {
    const memory = {
      remarks: [
        { ts: '1760054000.000100', userName: '지훈', text: '내일 회의 있죠?', own: false },
        { ts: '1760054100.000100', userName: '클로이', text: '네, 10시입니다.', own: true },
        { ts: '1760054400.000100', userName: '지훈', text: '내일 회의 몇 시죠?', own: false },
      ],
      notes: [{ at: '2026-10-10T00:10:00.000Z', text: '회의 시간 안내함' }],
    };
    const prompt = messagesPrompt(
      [inboxMessage('1760054400.000100', 'D1', '내일 회의 몇 시죠?')],
      'Asia/Seoul',
      memory,
    );
    expect(prompt).toContain('지훈: 내일 회의 있죠?');
    expect(prompt).toContain('나: 네, 10시입니다.');
    expect(prompt).toContain('[10. 10. 오전 9:10] 회의 시간 안내함');
    expect(prompt.match(/내일 회의 몇 시죠\?/g)).toHaveLength(1);
    expect(prompt.indexOf('최근 기록')).toBeLessThan(prompt.indexOf('새 Slack 메시지'));

    const resumed = resumePrompt('2단계까지 함', 'Asia/Seoul', memory);
    expect(resumed).toContain('2단계까지 함');
    expect(resumed).toContain('회의 시간 안내함');
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
