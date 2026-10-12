/**
 * Which messages reach the agent at all.
 *
 * Slack (the settings layer) delivers everything the agent's account can see;
 * this module (the application layer) decides what is addressed to it — the
 * way a person skims a channel and only answers what concerns them. It also
 * holds the stop rule that keeps agents from talking to each other forever.
 *
 * Addressed:
 *   - a DM or a group DM the agent is in,
 *   - a channel message that mentions the agent,
 *   - a reply in a thread the agent has posted in (or started).
 *
 * Loop guard: once the agent has posted `maxAgentExchanges` messages in a
 * channel with no human message in between, only humans are answered there
 * until a human speaks again.
 */
import type { SlackMessageEvent } from '../slack/types';

export type Verdict =
  | { readonly deliver: true }
  | {
      readonly deliver: false;
      readonly reason: 'duplicate' | 'system' | 'bot' | 'self' | 'not-addressed' | 'loop-guard';
    };

/** Subtypes that are someone actually saying something. Everything else is bookkeeping. */
const SPOKEN_SUBTYPES = new Set([undefined, 'thread_broadcast', 'file_share', 'me_message']);

/** How many message ids / threads to remember. Old ones fall out first. */
const MEMORY_LIMIT = 2000;

/** A Set that forgets its oldest entries past a limit. */
class BoundedSet {
  private readonly items = new Set<string>();

  constructor(private readonly limit: number) {}

  has(item: string): boolean {
    return this.items.has(item);
  }

  add(item: string): void {
    this.items.delete(item);
    this.items.add(item);
    if (this.items.size > this.limit) {
      const oldest = this.items.values().next().value;
      if (oldest !== undefined) this.items.delete(oldest);
    }
  }
}

export interface AddressingOptions {
  readonly agentUserId: string;
  readonly humanUserIds: readonly string[];
  readonly maxAgentExchanges: number;
}

export class Addressing {
  private readonly seen = new BoundedSet(MEMORY_LIMIT);
  private readonly threadsJoined = new BoundedSet(MEMORY_LIMIT);
  /** Agent messages per channel since the last human message there. */
  private readonly agentRunLength = new Map<string, number>();
  private readonly humans: ReadonlySet<string>;

  constructor(private readonly options: AddressingOptions) {
    this.humans = new Set(options.humanUserIds);
  }

  /** Looks at every message the ears hear, in order, and says whether it reaches the agent. */
  observe(event: SlackMessageEvent): Verdict {
    // The same message can arrive twice (redelivery, overlapping subscriptions).
    const id = `${event.channel}:${event.ts}`;
    if (this.seen.has(id)) return { deliver: false, reason: 'duplicate' };
    this.seen.add(id);

    if (!SPOKEN_SUBTYPES.has(event.subtype)) return { deliver: false, reason: 'system' };
    if (!event.user || event.botId) return { deliver: false, reason: 'bot' };

    if (event.user === this.options.agentUserId) {
      // The agent's own message — sent on screen, heard here. It joins the
      // thread it was posted in (or the thread it may start).
      this.threadsJoined.add(`${event.channel}:${event.threadTs ?? event.ts}`);
      this.agentRunLength.set(event.channel, (this.agentRunLength.get(event.channel) ?? 0) + 1);
      return { deliver: false, reason: 'self' };
    }

    const fromHuman = this.humans.has(event.user);
    if (fromHuman) this.agentRunLength.delete(event.channel);

    if (!this.isAddressed(event)) return { deliver: false, reason: 'not-addressed' };

    const runLength = this.agentRunLength.get(event.channel) ?? 0;
    if (!fromHuman && runLength >= this.options.maxAgentExchanges) {
      return { deliver: false, reason: 'loop-guard' };
    }
    return { deliver: true };
  }

  private isAddressed(event: SlackMessageEvent): boolean {
    if (event.channelType === 'im' || event.channelType === 'mpim') return true;
    if (event.text.includes(`<@${this.options.agentUserId}>`)) return true;
    return (
      event.threadTs !== undefined && this.threadsJoined.has(`${event.channel}:${event.threadTs}`)
    );
  }
}
