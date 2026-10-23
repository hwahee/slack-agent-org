/**
 * Catch-up — what was said while the ears were not listening.
 *
 * Socket Mode only delivers what happens while connected: a restart, a power
 * cut or a dropped line leaves a gap nobody replays. A person back at their
 * desk scrolls up; the catch-up does the same through the read-only history
 * (../slack/history.ts) and hands whatever the ears never heard to the intake,
 * as if just heard — so the addressing rules, triage and the queue apply as
 * usual. It calls no model; the only cost is a few read calls.
 *
 * Where to start is `heardUntil` in the state: the moment of the last
 * finished catch-up. The very first run only sets it — the agent does not
 * answer everything ever said before it existed. Each run looks a minute
 * further back than that (events in flight), and skips anything already
 * remembered or already heard. Messages older than `maxAgeMs` are only
 * remembered: too late to answer.
 *
 * Threads: history lists new top-level messages, and roots with new replies.
 * A reply under an older root is found only in threads the agent remembers —
 * the most recent few it saw replies in (or started itself, in a channel)
 * during the last week. A thread it never saw before the gap, with an old
 * root, stays out of reach.
 */
import { describeError, type Logger } from '../lib/log';
import type { SlackConversation, SlackHistory, SlackMessageEvent } from '../slack/types';
import type { ConversationMemory, StateStore } from '../state/types';
import type { Intake } from './intake';

export interface CatchupDeps {
  readonly history: SlackHistory;
  readonly state: Pick<StateStore, 'heardUntil' | 'setHeardUntil' | 'allMemories'>;
  readonly intake: Intake;
  /** Missed messages older than this are only remembered, never answered. */
  readonly maxAgeMs: number;
  readonly log: Logger;
  readonly now?: () => Date;
}

/** How far before `heardUntil` each run looks, for events that were in flight. */
const OVERLAP_MS = 60_000;
/** Remembered threads younger than this are checked for replies. */
const THREAD_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
/** At most this many remembered threads per conversation are checked (newest first). */
const THREADS_CHECKED = 10;

const tsMs = (ts: string) => Number(ts) * 1000;
const toTs = (ms: number) => (ms / 1000).toFixed(6);
const byTs = (a: { ts: string }, b: { ts: string }) => Number(a.ts) - Number(b.ts);

export class Catchup {
  private current: Promise<void> | undefined;
  private queued: Promise<void> | undefined;

  constructor(private readonly deps: CatchupDeps) {}

  /**
   * Looks for missed messages. Runs one at a time; a call made while one runs
   * waits and runs once more after it (calls during that wait share it).
   * Never rejects: a failure is logged and the next run covers the same gap.
   */
  run(): Promise<void> {
    if (this.queued) return this.queued;
    if (this.current) {
      this.queued = this.current.then(() => {
        this.queued = undefined;
        return this.start();
      });
      return this.queued;
    }
    return this.start();
  }

  /** Resolves once no catch-up is running or waiting (for shutdown). */
  settled(): Promise<void> {
    return this.queued ?? this.current ?? Promise.resolve();
  }

  private start(): Promise<void> {
    const run = this.once().finally(() => {
      if (this.current === run) this.current = undefined;
    });
    this.current = run;
    return run;
  }

  private async once(): Promise<void> {
    const { state, log } = this.deps;
    const started = (this.deps.now ?? (() => new Date()))();
    try {
      const since = await state.heardUntil();
      if (since === undefined) {
        await state.setHeardUntil(started.toISOString());
        log.info('catch-up: nothing heard before; starting from now');
        return;
      }
      const oldest = toTs(Date.parse(since) - OVERLAP_MS);
      const { missed, reads } = await this.findMissed(oldest, started);

      let answered = 0;
      let rememberedOnly = 0;
      for (const event of missed) {
        const tooOld = started.getTime() - tsMs(event.ts) > this.deps.maxAgeMs;
        await this.deps.intake(event, tooOld ? { rememberOnly: true } : { missed: true });
        if (tooOld) rememberedOnly += 1;
        else answered += 1;
      }
      await state.setHeardUntil(started.toISOString());

      const fields = { since, reads, found: missed.length, answered, rememberedOnly };
      if (missed.length > 0) log.info('catch-up: found missed messages', fields);
      else log.debug('catch-up: nothing missed', fields);
    } catch (error) {
      log.warn('catch-up failed; the next one covers the same gap', {
        error: describeError(error),
      });
    }
  }

  /** Everything said after `oldest` that the agent neither remembers nor heard, oldest first. */
  private async findMissed(
    oldest: string,
    started: Date,
  ): Promise<{ missed: SlackMessageEvent[]; reads: number }> {
    const { history, state } = this.deps;
    const memories = await state.allMemories();
    const conversations = await history.conversations();
    let reads = 1;
    const found = new Map<string, SlackMessageEvent>();
    const add = (event: SlackMessageEvent) => found.set(`${event.channel}:${event.ts}`, event);

    for (const conversation of conversations) {
      const top = await history.messagesSince(conversation, oldest);
      reads += 1;
      top.forEach(add);

      const threads = new Set(
        top
          .filter((m) => m.latestReply !== undefined && Number(m.latestReply) > Number(oldest))
          .map((m) => m.ts),
      );
      for (const thread of this.rememberedThreads(conversation, memories, started)) {
        threads.add(thread);
      }
      for (const thread of threads) {
        (await history.repliesSince(conversation, thread, oldest)).forEach(add);
        reads += 1;
      }
    }

    const remembered = (event: SlackMessageEvent) =>
      memories.get(event.channel)?.remarks.some((r) => r.ts === event.ts) ?? false;
    const missed = [...found.values()].filter((event) => !remembered(event)).sort(byTs);
    return { missed, reads };
  }

  /** Threads in this conversation the agent saw replies in, or started in a channel, lately. */
  private rememberedThreads(
    conversation: SlackConversation,
    memories: ReadonlyMap<string, ConversationMemory>,
    started: Date,
  ): string[] {
    const memory = memories.get(conversation.id);
    if (!memory) return [];
    const inChannel = conversation.type === 'channel' || conversation.type === 'group';
    const lastSeen = new Map<string, number>();
    for (const remark of memory.remarks) {
      if (started.getTime() - tsMs(remark.ts) >= THREAD_LOOKBACK_MS) continue;
      const thread = remark.threadTs ?? (remark.own && inChannel ? remark.ts : undefined);
      if (thread !== undefined)
        lastSeen.set(thread, Math.max(lastSeen.get(thread) ?? 0, tsMs(remark.ts)));
    }
    return [...lastSeen.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, THREADS_CHECKED)
      .map(([thread]) => thread);
  }
}
