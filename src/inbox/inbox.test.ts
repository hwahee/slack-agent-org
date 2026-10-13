import { describe, expect, test } from 'bun:test';

import { silentLogger } from '../lib/log';
import { createMemoryDirectory } from '../slack/memory';
import { createMemoryStateStore } from '../state/memory';
import { Addressing } from './addressing';
import { Inbox } from './inbox';
import { createIntake } from './intake';
import { inboxMessage } from '../testing/fixtures';

describe('Inbox', () => {
  test('counts unseen messages until the agent looks', () => {
    const inbox = new Inbox();
    inbox.push(inboxMessage('1.0'));
    inbox.push(inboxMessage('2.0'));
    expect(inbox.unseenCount).toBe(2);

    expect(inbox.peek().map((m) => m.id)).toEqual(['D1:1.0', 'D1:2.0']);
    expect(inbox.unseenCount).toBe(0);
    expect(inbox.size).toBe(2); // looking is not handling

    inbox.push(inboxMessage('3.0'));
    expect(inbox.unseenCount).toBe(1);
  });

  test('ignores a message pushed twice', () => {
    const inbox = new Inbox();
    inbox.push(inboxMessage('1.0'));
    inbox.push(inboxMessage('1.0'));
    expect(inbox.size).toBe(1);
  });

  test('take removes only what the agent took', () => {
    const inbox = new Inbox();
    inbox.push(inboxMessage('1.0'));
    inbox.push(inboxMessage('2.0'));
    expect(inbox.take(['D1:2.0', 'missing']).map((m) => m.id)).toEqual(['D1:2.0']);
    expect(inbox.peek().map((m) => m.id)).toEqual(['D1:1.0']);
  });

  test('hands out the oldest conversation with all of its messages', () => {
    const inbox = new Inbox();
    inbox.push(inboxMessage('1.0', 'A'));
    inbox.push(inboxMessage('2.0', 'B'));
    inbox.push(inboxMessage('3.0', 'A'));

    const first = inbox.takeNextConversation();
    expect(first?.conversation).toBe('A');
    expect(first?.messages.map((m) => m.id)).toEqual(['A:1.0', 'A:3.0']);
    expect(inbox.takeNextConversation()?.conversation).toBe('B');
    expect(inbox.takeNextConversation()).toBeNull();
  });

  test('wakes a waiter on the next message, or on abort', async () => {
    const inbox = new Inbox();
    const controller = new AbortController();

    const waiting = inbox.waitForMessage(controller.signal);
    inbox.push(inboxMessage('1.0'));
    await waiting;

    inbox.take(['D1:1.0']);
    const aborted = inbox.waitForMessage(controller.signal);
    controller.abort();
    await aborted;
  });

  test('restores a snapshot', () => {
    const inbox = new Inbox();
    inbox.push(inboxMessage('1.0'));
    const copy = new Inbox();
    copy.restore(inbox.snapshot());
    expect(copy.peek().map((m) => m.id)).toEqual(['D1:1.0']);
  });
});

describe('intake', () => {
  test('delivers an addressed message with the names a person would see', async () => {
    const inbox = new Inbox();
    const state = createMemoryStateStore();
    const intake = createIntake({
      addressing: new Addressing({
        agentUserId: 'U0AGENT',
        humanUserIds: ['U0HUMAN'],
        maxAgentExchanges: 3,
      }),
      directory: createMemoryDirectory({ users: { U0HUMAN: '지훈' }, channels: { C1: 'team' } }),
      inbox,
      state,
      log: silentLogger,
    });

    await intake({
      channel: 'C1',
      channelType: 'channel',
      user: 'U0HUMAN',
      text: 'no mention',
      ts: '1.0',
    });
    await intake({
      channel: 'C1',
      channelType: 'channel',
      user: 'U0HUMAN',
      text: '<@U0AGENT> 리뷰 부탁해요',
      ts: '2.0',
      threadTs: '1.0',
    });

    expect(inbox.peek()).toEqual([
      expect.objectContaining({
        id: 'C1:2.0',
        conversation: 'C1',
        channelName: 'team',
        userName: '지훈',
        threadTs: '1.0',
        text: '<@U0AGENT> 리뷰 부탁해요',
      }),
    ]);
    // Both are remembered as what was said in the channel, delivered or not.
    expect((await state.memoryOf('C1')).remarks.map((r) => r.text)).toEqual([
      'no mention',
      '<@U0AGENT> 리뷰 부탁해요',
    ]);
  });
});
