/**
 * Socket Mode envelope → {@link SlackMessageEvent}. Pure, so the shape Slack
 * sends is pinned by tests rather than discovered in production.
 */
import { s, toValidator } from '../validation';

import type { SlackMessageEvent } from './types';

const envelopeValidator = toValidator(
  s.looseObject({
    event: s.looseObject({
      type: s.string(),
      channel: s.optional(s.string()),
      channel_type: s.optional(s.string()),
      user: s.optional(s.string()),
      text: s.optional(s.string()),
      ts: s.optional(s.string()),
      thread_ts: s.optional(s.string()),
      subtype: s.optional(s.string()),
      bot_id: s.optional(s.string()),
    }),
  }),
);

const CHANNEL_TYPES = new Set(['im', 'mpim', 'channel', 'group']);

function isChannelType(value: string): value is SlackMessageEvent['channelType'] {
  return CHANNEL_TYPES.has(value);
}

/** Returns the message event inside an `events_api` payload, or null for anything else. */
export function parseMessageEnvelope(payload: unknown): SlackMessageEvent | null {
  const parsed = envelopeValidator.safeParse(payload);
  if (!parsed.ok) return null;
  const { event } = parsed.value;
  if (event.type !== 'message' || !event.channel || !event.ts) return null;
  if (!event.channel_type || !isChannelType(event.channel_type)) return null;

  return {
    channel: event.channel,
    channelType: event.channel_type,
    ts: event.ts,
    text: event.text ?? '',
    ...(event.user !== undefined && { user: event.user }),
    ...(event.thread_ts !== undefined && { threadTs: event.thread_ts }),
    ...(event.subtype !== undefined && { subtype: event.subtype }),
    ...(event.bot_id !== undefined && { botId: event.bot_id }),
  };
}
