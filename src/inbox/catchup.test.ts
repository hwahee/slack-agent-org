import { describe, expect, test } from 'bun:test';

import { messagesPrompt } from '../agent/prompts';
import { silentLogger } from '../lib/log';
import { createMemoryDirectory, createMemoryHistory } from '../slack/memory';
import type { SlackHistory } from '../slack/types';
import { createMemoryStateStore } from '../state/memory';
import { Addressing } from './addressing';
import { Catchup } from './catchup';
import { Inbox } from './inbox';
import { createIntake } from './intake';

const AGENT = 'U0AGENT';
const HUMAN = 'U0HUMAN';

/** Slack ts for a UTC ISO time. */
const ts = (iso: string) => (Date.parse(iso) / 1000).toFixed(6);

const HEARD_UNTIL = '2026-10-22T05:00:00.000Z';
const NOW = new Date('2026-10-22T06:30:00.000Z');

async function setup(options: { heardUntil?: string; history?: SlackHistory } = {}) {
  const history = createMemoryHistory();
  const state = createMemoryStateStore();
  if (options.heardUntil !== undefined) await state.setHeardUntil(options.heardUntil);
  const inbox = new Inbox();
  const addressing = new Addressing({
    agentUserId: AGENT,
    humanUserIds: [HUMAN],
    maxAgentExchanges: 4,
  });
  const overheard: string[] = [];
  const intake = createIntake({
    addressing,
    directory: createMemoryDirectory({ users: { [HUMAN]: '지훈' }, channels: { C1: 'team' } }),
    inbox,
    state,
    triage: { consider: (message) => void overheard.push(message.text) },
    log: silentLogger,
  });
  const catchup = new Catchup({
    history: options.history ?? history,
    state,
    intake,
    maxAgeMs: 24 * 60 * 60 * 1000,
    log: silentLogger,
    now: () => NOW,
  });
  return { history, state, inbox, addressing, intake, catchup, overheard };
}

describe('Catchup', () => {
  test('the first run only marks where hearing starts', async () => {
    const { history, state, inbox, catchup } = await setup();
    history.post({ channel: 'D1', channelType: 'im', user: HUMAN, text: '예전 말', ts: '1.0' });

    await catchup.run();

    expect(await state.heardUntil()).toBe(NOW.toISOString());
    expect(inbox.size).toBe(0);
    expect(history.reads).toBe(0);
  });

  test('a DM sent while nobody listened reaches the inbox, marked as found late', async () => {
    const { history, state, inbox, catchup } = await setup({ heardUntil: HEARD_UNTIL });
    history.post({
      channel: 'D1',
      channelType: 'im',
      user: HUMAN,
      text: '보고서 언제 돼요?',
      ts: ts('2026-10-22T05:30:00.000Z'),
    });
    history.post({
      channel: 'D1',
      channelType: 'im',
      user: HUMAN,
      text: '꺼지기 전에 이미 들은 말',
      ts: ts('2026-10-22T04:00:00.000Z'),
    });

    await catchup.run();

    const [message] = inbox.peek();
    expect(inbox.size).toBe(1);
    expect(message).toMatchObject({ text: '보고서 언제 돼요?', missed: true, userName: '지훈' });
    expect(messagesPrompt([message!], 'Asia/Seoul')).toContain('늦게 확인');
    expect(await state.heardUntil()).toBe(NOW.toISOString());
    // Remembered like anything heard.
    expect((await state.memoryOf('D1')).remarks.map((r) => r.text)).toEqual(['보고서 언제 돼요?']);
  });

  test('skips what is remembered or was heard live, so nothing is answered twice', async () => {
    const { history, state, inbox, intake, catchup } = await setup({ heardUntil: HEARD_UNTIL });
    const remembered = ts('2026-10-22T04:59:30.000Z'); // inside the one-minute overlap
    const heardLive = ts('2026-10-22T05:10:00.000Z');
    await state.remember('D1', { ts: remembered, userName: '지훈', text: '들은 말', own: false });
    for (const [at, text] of [
      [remembered, '들은 말'],
      [heardLive, '방금 귀로 들은 말'],
    ] as const) {
      history.post({ channel: 'D1', channelType: 'im', user: HUMAN, text, ts: at });
    }
    await intake({
      channel: 'D1',
      channelType: 'im',
      user: HUMAN,
      text: '방금 귀로 들은 말',
      ts: heardLive,
    });
    inbox.take(inbox.peek().map((m) => m.id)); // answered already

    await catchup.run();

    expect(inbox.size).toBe(0);
  });

  test('messages older than the limit are only remembered', async () => {
    const { history, state, inbox, catchup } = await setup({
      heardUntil: '2026-10-20T00:00:00.000Z',
    });
    history.post({
      channel: 'D1',
      channelType: 'im',
      user: HUMAN,
      text: '이틀 전 질문',
      ts: ts('2026-10-20T06:00:00.000Z'),
    });

    await catchup.run();

    expect(inbox.size).toBe(0);
    expect((await state.memoryOf('D1')).remarks.map((r) => r.text)).toEqual(['이틀 전 질문']);
  });

  test('finds replies in a thread the agent started before the gap', async () => {
    const { history, state, inbox, addressing, catchup } = await setup({
      heardUntil: HEARD_UNTIL,
    });
    const root = ts('2026-10-22T03:00:00.000Z');
    await state.remember('C1', {
      ts: root,
      userName: '클로이',
      text: '배포 끝났습니다',
      own: true,
    });
    addressing.recall(await state.allMemories());
    history.post({
      channel: 'C1',
      channelType: 'channel',
      user: AGENT,
      text: '배포 끝났습니다',
      ts: root,
    });
    history.post({
      channel: 'C1',
      channelType: 'channel',
      user: HUMAN,
      text: '로그도 확인했어요?',
      ts: ts('2026-10-22T05:20:00.000Z'),
      threadTs: root,
    });

    await catchup.run();

    // A reply in the agent's own thread is addressed to it, even across a restart.
    expect(inbox.peek()).toMatchObject([{ text: '로그도 확인했어요?', missed: true }]);
  });

  test('channel chatter it missed goes to triage, like chatter it hears', async () => {
    const { history, inbox, catchup, overheard } = await setup({ heardUntil: HEARD_UNTIL });
    history.post({
      channel: 'C1',
      channelType: 'channel',
      user: HUMAN,
      text: '배포 어디까지 됐는지 아는 사람?',
      ts: ts('2026-10-22T05:40:00.000Z'),
    });

    await catchup.run();

    expect(inbox.size).toBe(0);
    expect(overheard).toEqual(['배포 어디까지 됐는지 아는 사람?']);
  });

  test('a failed read changes nothing; the next run covers the same gap', async () => {
    const broken: SlackHistory = {
      conversations: () => Promise.reject(new Error('ratelimited')),
      messagesSince: () => Promise.resolve([]),
      repliesSince: () => Promise.resolve([]),
    };
    const { state, catchup } = await setup({ heardUntil: HEARD_UNTIL, history: broken });
    await catchup.run();
    expect(await state.heardUntil()).toBe(HEARD_UNTIL);
  });

  test('runs one at a time; calls made meanwhile share one more run', async () => {
    let calls = 0;
    let release = () => undefined as void;
    const slow: SlackHistory = {
      conversations: async () => {
        calls += 1;
        await new Promise<void>((resolve) => (release = resolve));
        return [];
      },
      messagesSince: () => Promise.resolve([]),
      repliesSince: () => Promise.resolve([]),
    };
    const { catchup } = await setup({ heardUntil: HEARD_UNTIL, history: slow });
    const first = catchup.run();
    await Bun.sleep(0);
    const second = catchup.run();
    const third = catchup.run();
    expect(second).toBe(third);
    release();
    await first;
    await Bun.sleep(0);
    const settled = catchup.settled();
    release();
    await second;
    await settled;
    expect(calls).toBe(2);
  });
});
