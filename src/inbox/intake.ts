/**
 * Ears → inbox: every heard message passes the addressing rules, gets the
 * names a person would see, and lands in the inbox — or, when the agent only
 * overheard it in a channel, goes to triage, which decides whether it should
 * answer anyway (../agent/triage.ts). Without triage, overheard messages are
 * only remembered.
 *
 * Whatever is said in a conversation is also remembered — messages for the
 * agent, the agent's own (sent on screen, heard here), and the rest of a
 * channel — so a turn can be told what was said before, the way a person
 * scrolls up. Only redeliveries and Slack's own bookkeeping are skipped.
 */
import { describeError, type Logger } from '../lib/log';
import type { SlackDirectory, SlackMessageEvent } from '../slack/types';
import type { StateStore } from '../state/types';
import type { Addressing, Verdict } from './addressing';
import type { Inbox } from './inbox';
import type { InboxMessage } from './types';

export interface IntakeDeps {
  readonly addressing: Addressing;
  readonly directory: SlackDirectory;
  readonly inbox: Inbox;
  readonly state: Pick<StateStore, 'remember'>;
  /** Where overheard channel messages go for a glance; absent = they are only remembered. */
  readonly triage?: { consider(message: InboxMessage): void };
  readonly log: Logger;
}

/** Said by someone in the conversation (the agent too), as opposed to a redelivery or bookkeeping. */
function wasSaid(verdict: Verdict): boolean {
  return (
    verdict.deliver || ['self', 'not-addressed', 'overheard', 'loop-guard'].includes(verdict.reason)
  );
}

export function createIntake({ addressing, directory, inbox, state, triage, log }: IntakeDeps) {
  async function remember(event: SlackMessageEvent, own: boolean): Promise<void> {
    if (!event.user) return;
    try {
      await state.remember(event.channel, {
        ts: event.ts,
        ...(event.threadTs !== undefined && { threadTs: event.threadTs }),
        userName: await directory.userName(event.user),
        text: event.text,
        own,
      });
    } catch (error) {
      log.error('remembering a message failed', { ts: event.ts, error: describeError(error) });
    }
  }

  return async function intake(event: SlackMessageEvent): Promise<void> {
    const verdict = addressing.observe(event);
    if (wasSaid(verdict)) {
      await remember(event, !verdict.deliver && verdict.reason === 'self');
    }
    const overheard = !verdict.deliver && verdict.reason === 'overheard' && triage !== undefined;
    if (!verdict.deliver && !overheard) {
      log.debug('message not delivered', {
        channel: event.channel,
        ts: event.ts,
        reason: verdict.reason,
      });
      return;
    }
    // `observe` only delivers (or overhears) messages with an author.
    const user = event.user ?? '';
    const [userName, channelName] = await Promise.all([
      directory.userName(user),
      event.channelType === 'im' ? Promise.resolve('') : directory.channelName(event.channel),
    ]);
    const message: InboxMessage = {
      id: `${event.channel}:${event.ts}`,
      conversation: event.channel,
      channel: event.channel,
      channelType: event.channelType,
      channelName,
      ts: event.ts,
      ...(event.threadTs !== undefined && { threadTs: event.threadTs }),
      user,
      userName,
      text: event.text,
      receivedAt: new Date().toISOString(),
    };
    if (overheard) {
      triage.consider(message);
      log.debug('message overheard', { id: message.id, from: userName, channel: channelName });
      return;
    }
    inbox.push(message);
    log.info('message received', { id: message.id, from: userName, channel: channelName || 'DM' });
  };
}
