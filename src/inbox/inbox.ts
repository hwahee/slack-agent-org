/**
 * The inbox — messages heard but not yet handled, like the unread badge on a
 * phone lying on the desk.
 *
 * The ears push into it at any moment. The agent never gets pulled out of its
 * work by it: while busy, it only sees a short notice ("2 new messages") on the
 * results of its own tool calls, and chooses when to look (`peek`), take a
 * message into the current task (`take`), or pause the task (inbox_yield).
 * Between turns the runtime takes the next conversation in arrival order —
 * messages addressed to the agent first, then the ones it only overheard and
 * chose to answer (`triage`), the way a person answers what was asked of them
 * before chiming in elsewhere.
 */
import { noopDiagnostics, type Diagnostics } from '../diag/types';
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

  /** `diag` writes down what is taken and how long it waited (docs/diagnostics.md). */
  constructor(private readonly diag: Diagnostics = noopDiagnostics) {
    diag.section('inbox', () => {
      const oldest = this.pending.reduce(
        (min, m) => Math.min(min, Date.parse(m.receivedAt)),
        Number.POSITIVE_INFINITY,
      );
      return {
        pending: this.pending.length,
        unseen: this.unseen,
        oldestWaitingMs: Number.isFinite(oldest) ? Date.now() - oldest : null,
      };
    });
  }

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
    return this.takeFor(ids, 'inbox_take');
  }

  private takeFor(ids: readonly string[], by: 'turn-start' | 'inbox_take'): InboxMessage[] {
    const wanted = new Set(ids);
    const taken = this.pending.filter((m) => wanted.has(m.id));
    this.pending = this.pending.filter((m) => !wanted.has(m.id));
    this.unseen = Math.min(this.unseen, this.pending.length);
    if (taken.length > 0) {
      const now = Date.now();
      this.diag.record('inbox.taken', {
        by,
        messages: taken.map((m) => ({ id: m.id, waitedMs: now - Date.parse(m.receivedAt) })),
      });
    }
    return taken;
  }

  /**
   * The conversation of the oldest message addressed to the agent (or, with
   * none waiting, of the oldest overheard one), with all of its waiting messages.
   */
  takeNextConversation(): ConversationBatch | null {
    const first = this.pending.find((m) => m.triage === undefined) ?? this.pending[0];
    if (!first) return null;
    const ids = this.pending.filter((m) => m.conversation === first.conversation).map((m) => m.id);
    return { conversation: first.conversation, messages: this.takeFor(ids, 'turn-start') };
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
