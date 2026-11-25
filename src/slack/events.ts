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

const envelopeMetaValidator = toValidator(
  s.looseObject({
    retry_attempt: s.optional(s.number()),
    retry_reason: s.optional(s.string()),
    payload: s.optional(
      s.looseObject({
        event_id: s.optional(s.string()),
        event_time: s.optional(s.number()),
        event: s.optional(
          s.looseObject({
            type: s.optional(s.string()),
            channel: s.optional(s.string()),
            channel_type: s.optional(s.string()),
            ts: s.optional(s.string()),
            subtype: s.optional(s.string()),
          }),
        ),
      }),
    ),
  }),
);

/** Where an envelope came from and whether it is a redelivery — for diagnostics only, never text. */
export interface EnvelopeMeta {
  readonly retryAttempt?: number;
  readonly retryReason?: string;
  readonly eventId?: string;
  readonly eventTime?: number;
  readonly eventType?: string;
  readonly channel?: string;
  readonly channelType?: string;
  readonly ts?: string;
  readonly subtype?: string;
}

/**
 * Reads the bookkeeping around an envelope (Slack's redelivery counters, the
 * event id and time, which message it carries). Pure; anything unreadable is
 * simply left out. Never returns message text or names.
 */
export function readEnvelopeMeta(frame: unknown): EnvelopeMeta {
  const parsed = envelopeMetaValidator.safeParse(frame);
  if (!parsed.ok) return {};
  const { retry_attempt, retry_reason, payload } = parsed.value;
  const event = payload?.event;
  return {
    ...(retry_attempt !== undefined && { retryAttempt: retry_attempt }),
    ...(retry_reason !== undefined && { retryReason: retry_reason }),
    ...(payload?.event_id !== undefined && { eventId: payload.event_id }),
    ...(payload?.event_time !== undefined && { eventTime: payload.event_time }),
    ...(event?.type !== undefined && { eventType: event.type }),
    ...(event?.channel !== undefined && { channel: event.channel }),
    ...(event?.channel_type !== undefined && { channelType: event.channel_type }),
    ...(event?.ts !== undefined && { ts: event.ts }),
    ...(event?.subtype !== undefined && { subtype: event.subtype }),
  };
}

const helloDebugValidator = toValidator(
  s.looseObject({
    debug_info: s.optional(
      s.looseObject({
        host: s.optional(s.string()),
        approximate_connection_time: s.optional(s.number()),
      }),
    ),
  }),
);

/** `debug_info` of a hello or disconnect frame (which Slack host, how long it plans to keep us). */
export function readDebugInfo(frame: unknown): {
  debugHost?: string;
  approximateConnectionTime?: number;
} {
  const parsed = helloDebugValidator.safeParse(frame);
  const info = parsed.ok ? parsed.value.debug_info : undefined;
  return {
    ...(info?.host !== undefined && { debugHost: info.host }),
    ...(info?.approximate_connection_time !== undefined && {
      approximateConnectionTime: info.approximate_connection_time,
    }),
  };
}
