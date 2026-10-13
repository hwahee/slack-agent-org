import type { ChannelType } from '../slack/types';

/**
 * A message waiting for the agent — what a notification would show a person.
 *
 * One Slack conversation (a channel or a DM, threads included) is one
 * `conversation`, and the runtime keeps one memory per conversation: the
 * agent remembers a channel the way a person does, not one thread at a time.
 */
export interface InboxMessage {
  /** `${channel}:${ts}` — unique per message. */
  readonly id: string;
  readonly conversation: string;
  readonly channel: string;
  readonly channelType: ChannelType;
  /** Channel name without `#`; empty for DMs. */
  readonly channelName: string;
  readonly ts: string;
  readonly threadTs?: string;
  readonly user: string;
  readonly userName: string;
  readonly text: string;
  /** When the ears heard it (UTC ISO). */
  readonly receivedAt: string;
}

/** A turn the agent paused itself at a safe point, to be picked up again later. */
export interface SuspendedTurn {
  /** Resumed with this conversation's memory, as it stands by then. */
  readonly conversation: string;
  /** The agent's own note on where it stopped and what comes next. */
  readonly note: string;
}

/** What survives a restart: messages not yet handled and turns not yet resumed. */
export interface QueueSnapshot {
  readonly pending: readonly InboxMessage[];
  readonly suspended: readonly SuspendedTurn[];
}
