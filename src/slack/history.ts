/**
 * Read-only history over the Web API — how the agent catches up on what the
 * ears missed (the process was down, the connection dropped), the way a person
 * back at their desk scrolls up.
 *
 * Only `users.conversations`, `conversations.history` and
 * `conversations.replies` are called — reads the token's scopes already allow
 * (`*:read`, `*:history`). This app is installed in its own workspace only
 * (an internal app), so these methods keep their Tier 3 rate limits.
 */
import { WebClient } from '@slack/web-api';

import type {
  ChannelType,
  HistoryMessage,
  SlackConversation,
  SlackHistory,
  SlackMessageEvent,
} from './types';

/** The fields of a history message the agent acts on (Slack's own types are loose). */
interface RawMessage {
  ts?: string;
  user?: string;
  text?: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
  latest_reply?: string;
}

interface RawChannel {
  id?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
}

function channelType(channel: RawChannel): ChannelType {
  if (channel.is_im) return 'im';
  if (channel.is_mpim) return 'mpim';
  return channel.is_private ? 'group' : 'channel';
}

function toEvent(conversation: SlackConversation, raw: RawMessage): HistoryMessage | null {
  if (!raw.ts) return null;
  return {
    channel: conversation.id,
    channelType: conversation.type,
    ts: raw.ts,
    text: raw.text ?? '',
    ...(raw.user !== undefined && { user: raw.user }),
    ...(raw.thread_ts !== undefined && { threadTs: raw.thread_ts }),
    ...(raw.subtype !== undefined && { subtype: raw.subtype }),
    ...(raw.bot_id !== undefined && { botId: raw.bot_id }),
    ...(raw.latest_reply !== undefined && { latestReply: raw.latest_reply }),
  };
}

const byTs = (a: { ts: string }, b: { ts: string }) => Number(a.ts) - Number(b.ts);

/** Every page of a cursored call. */
async function allPages<T>(
  page: (cursor: string | undefined) => Promise<{
    items: readonly T[];
    next: string | undefined;
  }>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const result = await page(cursor);
    items.push(...result.items);
    // Slack signals the last page with an empty cursor.
    cursor = result.next === '' ? undefined : result.next;
  } while (cursor);
  return items;
}

export function createWebHistory(token: string): SlackHistory {
  // Bounded: a poll waits for the catch-up, so one unanswered request (or the
  // client's default retries, which span about half an hour) must not stall
  // every poll after it. A failed catch-up is simply covered by the next one.
  const client = new WebClient(token, { timeout: 10_000, retryConfig: { retries: 2 } });

  return {
    async conversations() {
      const channels = await allPages<RawChannel>(async (cursor) => {
        const result = await client.users.conversations({
          types: 'public_channel,private_channel,mpim,im',
          exclude_archived: true,
          limit: 200,
          ...(cursor && { cursor }),
        });
        return { items: result.channels ?? [], next: result.response_metadata?.next_cursor };
      });
      return channels.flatMap((channel) =>
        channel.id ? [{ id: channel.id, type: channelType(channel) }] : [],
      );
    },

    async messagesSince(conversation, oldest) {
      const raw = await allPages<RawMessage>(async (cursor) => {
        const result = await client.conversations.history({
          channel: conversation.id,
          oldest,
          inclusive: false,
          limit: 200,
          ...(cursor && { cursor }),
        });
        return { items: result.messages ?? [], next: result.response_metadata?.next_cursor };
      });
      return raw.flatMap((message) => toEvent(conversation, message) ?? []).sort(byTs);
    },

    async repliesSince(conversation, threadTs, oldest) {
      const raw = await allPages<RawMessage>(async (cursor) => {
        const result = await client.conversations.replies({
          channel: conversation.id,
          ts: threadTs,
          oldest,
          inclusive: false,
          limit: 200,
          ...(cursor && { cursor }),
        });
        return { items: result.messages ?? [], next: result.response_metadata?.next_cursor };
      });
      // Slack always returns the thread root first, whatever `oldest` says.
      return raw
        .flatMap((message): SlackMessageEvent[] => {
          const event = toEvent(conversation, message);
          return event ? [event] : [];
        })
        .filter((event) => event.ts !== threadTs && Number(event.ts) > Number(oldest))
        .sort(byTs);
    },
  };
}
