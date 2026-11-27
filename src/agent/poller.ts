/**
 * The poller — a clock that goes off every POLL_MINUTES, like a person's
 * habit of glancing at the team every so often.
 *
 * On each poll the tasks run one after another. Tasks are plain code first:
 * the status heartbeat and the catch-up on missed messages call no model.
 * A task that needs a model's judgment should ask the cheapest one that will
 * do (a tool-less `Judge`), check `usage.budgetLeft()` first, and hand real
 * work to the inbox — never the desk: turns stay one at a time, in the runtime.
 *
 * A poll never overlaps the previous one (a slow poll skips the next), a
 * failing task is logged without stopping the others, and stopping waits for
 * the poll in progress to finish.
 */
import { noopDiagnostics, type Diagnostics } from '../diag/types';
import { describeError, type Logger } from '../lib/log';
import type { UsageLedger } from './usage';

export interface PollContext {
  /** When this poll started. */
  readonly now: Date;
  /** Uniform in [0, 1) — for tasks that act by chance. Injected so tests can fix it. */
  random(): number;
  readonly usage: Pick<UsageLedger, 'budgetLeft' | 'record'>;
}

export interface PollTask {
  /** For the log. */
  readonly name: string;
  run(context: PollContext): Promise<void>;
}

export interface PollerDeps {
  readonly tasks: readonly PollTask[];
  readonly intervalMs: number;
  readonly usage: PollContext['usage'];
  readonly log: Logger;
  readonly now?: () => Date;
  readonly random?: () => number;
  /** Each poll and how long its tasks took (docs/diagnostics.md). Observes only. */
  readonly diag?: Diagnostics;
}

export class Poller {
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling: Promise<void> | undefined;
  private readonly diag: Diagnostics;
  /** When the clock last went off (or was started) — for the next expected poll. */
  private lastTick: number | undefined;
  private lastStarted: Date | undefined;
  private lastEnded: Date | undefined;

  constructor(private readonly deps: PollerDeps) {
    this.diag = deps.diag ?? noopDiagnostics;
    this.diag.section('poll', () => ({
      everyMs: deps.intervalMs,
      lastStartedAt: this.lastStarted?.toISOString() ?? null,
      lastEndedAt: this.lastEnded?.toISOString() ?? null,
      nextAt:
        this.timer && this.lastTick !== undefined
          ? new Date(this.lastTick + deps.intervalMs).toISOString()
          : null,
    }));
  }

  /** Polls once now, then every interval. */
  start(): void {
    if (this.timer) return;
    this.lastTick = Date.now();
    this.timer = setInterval(() => {
      this.lastTick = Date.now();
      void this.poll();
    }, this.deps.intervalMs);
    void this.poll();
    this.deps.log.info('poller started', {
      everyMinutes: this.deps.intervalMs / 60_000,
      tasks: this.deps.tasks.map((task) => task.name),
    });
  }

  /** Stops the clock and waits for the poll in progress. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.polling;
  }

  /** Runs every task once, unless a poll is already running. Never rejects. */
  poll(): Promise<void> {
    if (this.polling) {
      this.deps.log.debug('previous poll still running; skipping this one');
      this.diag.record('poll.ran', { skipped: true, ms: 0, tasks: [] });
      return this.polling;
    }
    this.polling = this.runTasks().finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }

  private async runTasks(): Promise<void> {
    const { tasks, usage, log } = this.deps;
    const context: PollContext = {
      now: (this.deps.now ?? (() => new Date()))(),
      random: this.deps.random ?? Math.random,
      usage,
    };
    const pollStarted = performance.now();
    this.lastStarted = new Date();
    const ran: { name: string; ms: number; ok: boolean }[] = [];
    for (const task of tasks) {
      const taskStarted = performance.now();
      let ok = true;
      try {
        await task.run(context);
      } catch (error) {
        ok = false;
        log.error('poll task failed', { task: task.name, error: describeError(error) });
      }
      ran.push({ name: task.name, ms: Math.round(performance.now() - taskStarted), ok });
    }
    this.lastEnded = new Date();
    this.diag.record('poll.ran', {
      skipped: false,
      ms: Math.round(performance.now() - pollStarted),
      tasks: ran,
    });
  }
}
