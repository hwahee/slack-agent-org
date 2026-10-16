import { describe, expect, test } from 'bun:test';

import type { SlackMessageEvent } from '../slack/types';
import { Addressing } from './addressing';

const AGENT = 'U0AGENT';
const HUMAN = 'U0HUMAN';
const OTHER_AGENT = 'U0GPT';

let clock = 0;
function message(overrides: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
  clock += 1;
  return {
    channel: 'C1',
    channelType: 'channel',
    user: HUMAN,
    text: 'hello',
    ts: `${clock}.000`,
    ...overrides,
  };
}

function addressing(maxAgentExchanges = 3) {
  return new Addressing({ agentUserId: AGENT, humanUserIds: [HUMAN], maxAgentExchanges });
}

describe('Addressing', () => {
  test('delivers direct and group messages', () => {
    const a = addressing();
    expect(a.observe(message({ channel: 'D1', channelType: 'im' }))).toEqual({ deliver: true });
    expect(a.observe(message({ channel: 'G1', channelType: 'mpim' }))).toEqual({ deliver: true });
  });

  test('in channels, delivers what mentions the agent and overhears the rest', () => {
    const a = addressing();
    expect(a.observe(message({ text: `<@${AGENT}> lunch?` }))).toEqual({ deliver: true });
    expect(a.observe(message({ text: `<@${AGENT}|클로이> lunch?` }))).toEqual({ deliver: true });
    // Nobody asked the agent, but it might be the one to answer: triage decides.
    expect(a.observe(message({ text: 'lunch?' }))).toEqual({
      deliver: false,
      reason: 'overheard',
    });
    expect(a.observe(message({ threadTs: '999.000', text: 'in a thread' }))).toEqual({
      deliver: false,
      reason: 'overheard',
    });
  });

  test('a channel message that singles out someone else is not the agent’s', () => {
    const a = addressing();
    expect(a.observe(message({ text: `<@${OTHER_AGENT}> 이거 봐 줄래?` }))).toEqual({
      deliver: false,
      reason: 'not-addressed',
    });
    // …unless the agent is named too.
    expect(a.observe(message({ text: `<@${OTHER_AGENT}> <@${AGENT}> 둘 다 봐 줘` }))).toEqual({
      deliver: true,
    });
  });

  test('follows a thread once the agent has posted in it', () => {
    const a = addressing();
    const root = message({ text: `<@${AGENT}> can you check?` });
    a.observe(root);
    a.observe(message({ user: AGENT, threadTs: root.ts, text: 'on it' }));
    expect(a.observe(message({ threadTs: root.ts, text: 'thanks!' }))).toEqual({ deliver: true });
    expect(a.observe(message({ threadTs: '999.000', text: 'elsewhere' }))).toMatchObject({
      deliver: false,
    });
  });

  test('a thread under the agent’s own message counts as joined', () => {
    const a = addressing();
    const own = message({ user: AGENT, text: 'standup in 5' });
    a.observe(own);
    expect(a.observe(message({ threadTs: own.ts, text: 'ok' }))).toEqual({ deliver: true });
  });

  test('never delivers the agent’s own messages, bots or bookkeeping', () => {
    const a = addressing();
    expect(a.observe(message({ user: AGENT, channelType: 'im' }))).toEqual({
      deliver: false,
      reason: 'self',
    });
    expect(a.observe(message({ user: undefined, botId: 'B1', channelType: 'im' }))).toEqual({
      deliver: false,
      reason: 'bot',
    });
    expect(a.observe(message({ subtype: 'channel_join', channelType: 'im' }))).toEqual({
      deliver: false,
      reason: 'system',
    });
    expect(a.observe(message({ subtype: 'thread_broadcast', channelType: 'im' }))).toEqual({
      deliver: true,
    });
  });

  test('drops a message heard twice', () => {
    const a = addressing();
    const once = message({ channelType: 'im' });
    expect(a.observe(once)).toEqual({ deliver: true });
    expect(a.observe(once)).toEqual({ deliver: false, reason: 'duplicate' });
  });

  test('stops answering other agents after the run limit, until a human speaks', () => {
    const a = addressing(2);
    const fromGpt = () => message({ user: OTHER_AGENT, text: `<@${AGENT}> what do you think?` });

    expect(a.observe(fromGpt())).toEqual({ deliver: true });
    a.observe(message({ user: AGENT, text: 'reply 1' }));
    expect(a.observe(fromGpt())).toEqual({ deliver: true });
    a.observe(message({ user: AGENT, text: 'reply 2' }));
    expect(a.observe(fromGpt())).toEqual({ deliver: false, reason: 'loop-guard' });

    // A human is always answered, and speaking resets the run.
    expect(a.observe(message({ text: `<@${AGENT}> wrap it up` }))).toEqual({ deliver: true });
    expect(a.observe(fromGpt())).toEqual({ deliver: true });
  });

  test('the loop guard holds for overheard messages from agents too', () => {
    const a = addressing(1);
    a.observe(message({ user: AGENT, text: 'done' }));
    expect(a.observe(message({ user: OTHER_AGENT, text: 'nice' }))).toEqual({
      deliver: false,
      reason: 'loop-guard',
    });
    expect(a.observe(message({ text: 'anyone free?' }))).toEqual({
      deliver: false,
      reason: 'overheard',
    });
  });

  test('counts the run per channel', () => {
    const a = addressing(1);
    a.observe(message({ user: AGENT, channel: 'C1' }));
    expect(a.observe(message({ user: OTHER_AGENT, channel: 'C2', text: `<@${AGENT}>` }))).toEqual({
      deliver: true,
    });
  });
});
