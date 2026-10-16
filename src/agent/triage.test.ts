import { describe, expect, test } from 'bun:test';

import type { Judge } from '../engine/types';
import { Inbox } from '../inbox/inbox';
import type { InboxMessage } from '../inbox/types';
import { silentLogger } from '../lib/log';
import { createMemoryStateStore } from '../state/memory';
import { inboxMessage } from '../testing/fixtures';
import { triageSystemPrompt } from './prompts';
import { readDecision, Triage } from './triage';

/** An overheard channel message in #team (C1). */
function overheard(ts: string, text: string, user = 'U0HUMAN'): InboxMessage {
  return {
    ...inboxMessage(ts, 'C1', text),
    channelType: 'channel',
    channelName: 'team',
    user,
    userName: user === 'U0HUMAN' ? '지훈' : '지피티',
  };
}

/** A judge that answers from a script and records what it was asked. */
function scriptedJudge(answer: (prompt: string) => string | Promise<string>) {
  const asked: string[] = [];
  const judge: Judge = {
    async ask(prompt) {
      asked.push(prompt);
      return { text: await answer(prompt), costUsd: 0.001 };
    },
  };
  return { judge, asked };
}

function setup(judge: Judge, waitMs = 60_000) {
  const inbox = new Inbox();
  const state = createMemoryStateStore();
  const triage = new Triage({
    judge,
    inbox,
    state,
    humanUserIds: ['U0HUMAN'],
    timeZone: 'Asia/Seoul',
    waitMs,
    log: silentLogger,
  });
  return { inbox, state, triage };
}

describe('readDecision', () => {
  const judged = ['C1:1.0', 'C1:2.0'];

  test('reads the JSON line, even with words around it', () => {
    expect(
      readDecision('판단: {"respond": true, "ids": ["C1:2.0"], "reason": "배포 질문"}', judged),
    ).toEqual({ respond: true, ids: ['C1:2.0'], reason: '배포 질문' });
    expect(readDecision('{"respond": false, "ids": [], "reason": "잡담"}', judged)).toEqual({
      respond: false,
      ids: [],
      reason: '잡담',
    });
  });

  test('"respond" with no usable ids means all of the judged messages', () => {
    expect(readDecision('{"respond": true, "reason": "x"}', judged)?.ids).toEqual(judged);
    expect(readDecision('{"respond": true, "ids": ["C9:1.0"]}', judged)).toEqual({
      respond: true,
      ids: judged,
      reason: '(이유 없음)',
    });
  });

  test('an answer it cannot read is no decision', () => {
    expect(readDecision('네, 답하는 게 좋겠습니다.', judged)).toBeNull();
    expect(readDecision('{"respond": "maybe"}', judged)).toBeNull();
    expect(readDecision('{respond: true}', judged)).toBeNull();
  });
});

describe('Triage', () => {
  test('one glance per channel at what gathered; the chosen join the inbox with the reason', async () => {
    const { judge, asked } = scriptedJudge(
      () => '{"respond": true, "ids": ["C1:2.0"], "reason": "모두에게 던진 배포 질문"}',
    );
    const { inbox, state, triage } = setup(judge);
    await state.remember('C1', { ts: '0.5', userName: '클로이', text: '배포 끝났어요', own: true });

    triage.consider(overheard('1.0', 'ㅋㅋ 점심 뭐 먹지'));
    triage.consider(overheard('2.0', '근데 배포 어디까지 됐는지 아는 사람?'));
    triage.consider(overheard('3.0', '저도 궁금', 'U0GPT'));
    await triage.flush();

    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('나: 배포 끝났어요'); // what the channel said before
    expect(asked[0]).toContain('판단할 새 글 3건');
    expect(asked[0]).toContain('(작성자: 사람)');
    expect(asked[0]).toContain('(작성자: AI 에이전트)');
    expect(inbox.peek()).toEqual([
      expect.objectContaining({
        id: 'C1:2.0',
        triage: { reason: '모두에게 던진 배포 질문' },
      }) as InboxMessage,
    ]);
  });

  test('staying quiet leaves the inbox alone', async () => {
    const { judge } = scriptedJudge(() => '{"respond": false, "ids": [], "reason": "잡담"}');
    const { inbox, triage } = setup(judge);
    triage.consider(overheard('1.0', '점심 뭐 먹지'));
    await triage.flush();
    expect(inbox.size).toBe(0);
  });

  test('in doubt — an unreadable answer or a failed call — the agent stays quiet', async () => {
    for (const answer of [
      () => '답해야 할 것 같아요',
      () => {
        throw new Error('not logged in');
      },
    ]) {
      const { judge } = scriptedJudge(answer);
      const { inbox, triage } = setup(judge);
      triage.consider(overheard('1.0', '누구 아는 사람?'));
      await triage.flush();
      expect(inbox.size).toBe(0);
    }
  });

  test('glances on its own once the gathering time is up', async () => {
    const { judge, asked } = scriptedJudge(() => '{"respond": true, "reason": "질문"}');
    const { inbox, triage } = setup(judge, 5);
    triage.consider(overheard('1.0', '누구 아는 사람?'));
    expect(asked).toHaveLength(0);
    await Bun.sleep(30);
    expect(asked).toHaveLength(1);
    expect(inbox.size).toBe(1);
  });

  test('each channel gets its own glance', async () => {
    const { judge, asked } = scriptedJudge(() => '{"respond": false, "reason": "-"}');
    const { triage } = setup(judge);
    triage.consider(overheard('1.0', 'a'));
    triage.consider({ ...overheard('2.0', 'b'), id: 'C2:2.0', conversation: 'C2', channel: 'C2' });
    await triage.flush();
    expect(asked).toHaveLength(2);
  });

  test('stopping drops what gathered but lets the glance in progress finish', async () => {
    let release = () => undefined as void;
    const { judge, asked } = scriptedJudge(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve('{"respond": true, "reason": "질문"}');
        }),
    );
    const { inbox, triage } = setup(judge);
    triage.consider(overheard('1.0', '누구 아는 사람?'));
    const glancing = triage.flush();
    await Bun.sleep(0);
    triage.consider({ ...overheard('2.0', 'b'), id: 'C2:2.0', conversation: 'C2', channel: 'C2' });

    const stopped = triage.stop();
    release();
    await Promise.all([glancing, stopped]);

    expect(asked).toHaveLength(1);
    expect(inbox.peek().map((m) => m.id)).toEqual(['C1:1.0']);
    triage.consider(overheard('3.0', 'after stop'));
    await triage.flush();
    expect(asked).toHaveLength(1);
  });
});

describe('triageSystemPrompt', () => {
  test('names the agent, its role (or the lack of one) and the answer format', () => {
    const base = { agentName: '에이전트1', agentSlackUserId: 'U0AGENT' };
    const prompt = triageSystemPrompt({ ...base, agentRole: '배포와 서버 상태를 맡습니다.' });
    expect(prompt).toContain('에이전트1');
    expect(prompt).toContain('U0AGENT');
    expect(prompt).toContain('배포와 서버 상태를 맡습니다.');
    expect(prompt).toContain('"respond"');
    expect(triageSystemPrompt(base)).toContain('아직 정해진 담당 업무가 없습니다');
  });
});
