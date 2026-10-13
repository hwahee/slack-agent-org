/**
 * Ears → inbox: every heard message passes the addressing rules, gets the
 * names a person would see, and lands in the inbox.
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
  readonly log: Logger;
}

/** Said by someone in the conversation (the agent too), as opposed to a redelivery or bookkeeping. */
function wasSaid(verdict: Verdict): boolean {
  return verdict.deliver || ['self', 'not-addressed', 'loop-guard'].includes(verdict.reason);
}

export function createIntake({ addressing, directory, inbox, state, log }: IntakeDeps) {
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
    if (!verdict.deliver) {
      log.debug('message not delivered', {
        channel: event.channel,
        ts: event.ts,
        reason: verdict.reason,
      });
      return;
    }
    // `observe` only delivers messages with an author.
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
    inbox.push(message);
    log.info('message received', { id: message.id, from: userName, channel: channelName || 'DM' });
  };
}
