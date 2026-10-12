/**
 * Ears → inbox: every heard message passes the addressing rules, gets the
 * names a person would see, and lands in the inbox.
 */
import type { Logger } from '../lib/log';
import type { SlackDirectory, SlackMessageEvent } from '../slack/types';
import type { Addressing } from './addressing';
import type { Inbox } from './inbox';
import type { InboxMessage } from './types';

export interface IntakeDeps {
  readonly addressing: Addressing;
  readonly directory: SlackDirectory;
  readonly inbox: Inbox;
  readonly log: Logger;
}

export function createIntake({ addressing, directory, inbox, log }: IntakeDeps) {
  return async function intake(event: SlackMessageEvent): Promise<void> {
    const verdict = addressing.observe(event);
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
