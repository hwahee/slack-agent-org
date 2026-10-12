/**
 * The inbox — messages heard but not yet handled, like the unread badge on a
 * phone lying on the desk.
 *
 * The ears push into it at any moment. The agent never gets pulled out of its
 * work by it: while busy, it only sees a short notice ("2 new messages") on the
 * results of its own tool calls, and chooses when to look (`peek`), take a
 * message into the current task (`take`), or pause the task (inbox_yield).
 * Between turns the runtime takes the next conversation in arrival order.
 */
import type { InboxMessage } from './types';

export interface ConversationBatch {
  readonly conversation: string;
  readonly messages: readonly InboxMessage[];
}

export class Inbox {
  private pending: InboxMessage[] = [];
  /** Messages that arrived since the agent last looked. */
  private unseen = 0;
  private readonly waiters = new Set<() => void>();

  push(message: InboxMessage): void {
    if (this.pending.some((m) => m.id === message.id)) return;
    this.pending.push(message);
    this.unseen += 1;
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  get size(): number {
    return this.pending.length;
  }

  /** How many messages arrived since the agent last looked — the badge number. */
  get unseenCount(): number {
    return this.unseen;
  }

  /** Everything waiting, oldest first. Looking clears the badge. */
  peek(): readonly InboxMessage[] {
    this.unseen = 0;
    return [...this.pending];
  }

  /** Removes the given messages (the agent is handling them now) and returns those found. */
  take(ids: readonly string[]): InboxMessage[] {
    const wanted = new Set(ids);
    const taken = this.pending.filter((m) => wanted.has(m.id));
    this.pending = this.pending.filter((m) => !wanted.has(m.id));
    this.unseen = Math.min(this.unseen, this.pending.length);
    return taken;
  }

  /** The conversation of the oldest waiting message, with all of its waiting messages. */
  takeNextConversation(): ConversationBatch | null {
    const first = this.pending[0];
    if (!first) return null;
    const ids = this.pending.filter((m) => m.conversation === first.conversation).map((m) => m.id);
    return { conversation: first.conversation, messages: this.take(ids) };
  }

  /** Resolves once something is waiting (at once if something already is), or on abort. */
  waitForMessage(signal: AbortSignal): Promise<void> {
    if (this.pending.length > 0 || signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.waiters.delete(done);
        signal.removeEventListener('abort', done);
        resolve();
      };
      this.waiters.add(done);
      signal.addEventListener('abort', done, { once: true });
    });
  }

  snapshot(): readonly InboxMessage[] {
    return [...this.pending];
  }

  /** Puts saved messages back (after a restart). They count as unseen. */
  restore(messages: readonly InboxMessage[]): void {
    for (const message of messages) this.push(message);
  }
}
