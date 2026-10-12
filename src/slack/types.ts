/**
 * The agent's ears — contracts.
 *
 * Slack enters the process through two doors only, both one-way inward:
 *
 *   - {@link SlackListener}: Socket Mode events (outbound WebSocket; no inbound
 *     port is ever opened on the home network).
 *   - {@link SlackDirectory}: read-only lookups, so a notification can say
 *     "#team · 지훈" instead of "C04… · U07…" — what a person would see.
 *
 * There is deliberately no third door. Replying happens on screen (src/desk).
 */

export type ChannelType = 'im' | 'mpim' | 'channel' | 'group';

/** A Slack `message` event, reduced to what the agent acts on. */
export interface SlackMessageEvent {
  readonly channel: string;
  readonly channelType: ChannelType;
  /** Author. Absent on some bot/system messages. */
  readonly user?: string;
  readonly text: string;
  /** The message's own timestamp — its id within the channel. */
  readonly ts: string;
  /** Set when the message is inside a thread (equals `ts` for the thread root). */
  readonly threadTs?: string;
  readonly subtype?: string;
  readonly botId?: string;
}

export interface SlackListener {
  /** Connects and starts delivering message events. */
  start(onMessage: (event: SlackMessageEvent) => void): Promise<void>;
  stop(): Promise<void>;
}

export interface SlackDirectory {
  /**
   * Fails when the token can do more than read (CLAUDE.md: sending never goes
   * through the API). Called once at boot, before anything is received.
   */
  assertReadOnly(): Promise<void>;
  /** Display name; falls back to the id when the lookup fails. */
  userName(userId: string): Promise<string>;
  /** Channel name without `#`; falls back to the id when the lookup fails. */
  channelName(channelId: string): Promise<string>;
}
