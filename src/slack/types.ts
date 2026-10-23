/**
 * The agent's ears — contracts.
 *
 * Slack enters the process through three doors only, all one-way inward:
 *
 *   - {@link SlackListener}: Socket Mode events (outbound WebSocket; no inbound
 *     port is ever opened on the home network).
 *   - {@link SlackDirectory}: read-only lookups, so a notification can say
 *     "#team · 지훈" instead of "C04… · U07…" — what a person would see.
 *   - {@link SlackHistory}: read-only history, to catch up on what the ears
 *     missed while the process was down or the connection dropped.
 *
 * There is deliberately no door for messages. Replying happens on screen
 * (src/desk). The one write is the agent's own status ({@link SlackStatus}).
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
  /**
   * Connects and starts delivering message events. `onConnected` runs on every
   * successful connection — the first and each reconnect — so whatever was said
   * while the line was down can be caught up on.
   */
  start(onMessage: (event: SlackMessageEvent) => void, onConnected?: () => void): Promise<void>;
  /** Whether the ears are hearing right now. */
  connected(): boolean;
  stop(): Promise<void>;
}

/** A conversation the agent's account is in. */
export interface SlackConversation {
  readonly id: string;
  readonly type: ChannelType;
}

/** A message from history, as the ears would have heard it. */
export interface HistoryMessage extends SlackMessageEvent {
  /** Newest reply in its thread, when it is a thread root with replies. */
  readonly latestReply?: string;
}

/**
 * Read-only history (`users.conversations`, `conversations.history`,
 * `conversations.replies`) — the same reads the scopes already allow.
 * Timestamps are Slack `ts` strings; "since" means strictly newer.
 */
export interface SlackHistory {
  conversations(): Promise<readonly SlackConversation[]>;
  /** Top-level messages (and broadcast replies) newer than `oldest`, oldest first. */
  messagesSince(
    conversation: SlackConversation,
    oldest: string,
  ): Promise<readonly HistoryMessage[]>;
  /** Replies in the thread `threadTs` newer than `oldest`, oldest first (never the root). */
  repliesSince(
    conversation: SlackConversation,
    threadTs: string,
    oldest: string,
  ): Promise<readonly SlackMessageEvent[]>;
}

export interface SlackDirectory {
  /**
   * Fails when the token can do more than read (CLAUDE.md: sending never goes
   * through the API). Called once at boot, before anything is received.
   * Resolves to the token's scopes.
   */
  assertReadOnly(): Promise<readonly string[]>;
  /** Display name; falls back to the id when the lookup fails. */
  userName(userId: string): Promise<string>;
  /** Channel name without `#`; falls back to the id when the lookup fails. */
  channelName(channelId: string): Promise<string>;
}

/** What the team sees next to the agent's name (src/agent/status.ts). */
export interface StatusLook {
  /** Emoji code, e.g. `:zzz:`. */
  readonly emoji: string;
  readonly text: string;
}

/** Sets the agent's own Slack status, never clearing on its own. */
export interface SlackStatus {
  set(look: StatusLook): Promise<void>;
}
