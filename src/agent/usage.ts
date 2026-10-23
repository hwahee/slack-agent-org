/**
 * Model spending per local day — what turns and glances cost (`costUsd` from
 * the engine), tallied in the state so it survives restarts.
 *
 * The daily budget (DAILY_BUDGET_USD) is for work the agent starts on its own
 * — poll tasks that would call a model. Nothing does yet; when one does, it
 * asks `budgetLeft()` first. Answering people and channel triage are never
 * held back by it: their spending counts toward the day, and crossing the
 * budget is logged.
 */
import { describeError, type Logger } from '../lib/log';
import type { DailyUsage, StateStore } from '../state/types';

/** What spent it. Poll tasks that call a model add their own name. */
export type UsageSource = 'turn' | 'triage' | (string & {});

export interface UsageDeps {
  readonly state: Pick<StateStore, 'usage' | 'setUsage'>;
  readonly timeZone: string;
  /** Unset = no cap. */
  readonly dailyBudgetUsd?: number;
  readonly log: Logger;
  readonly now?: () => Date;
}

/** `YYYY-MM-DD` of `date` in `timeZone`. */
export function localDay(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

const total = (usage: DailyUsage) =>
  Object.values(usage.bySource).reduce((sum, usd) => sum + usd, 0);
const round = (usd: number) => Math.round(usd * 10_000) / 10_000;

export class UsageLedger {
  /** Records are applied one at a time, in order. Never rejects. */
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly deps: UsageDeps) {}

  /** Adds what one turn or glance cost. Nothing to add (unknown, zero) is a no-op. */
  record(source: UsageSource, usd: number | undefined): Promise<void> {
    if (usd === undefined || !(usd > 0)) return this.writing;
    this.writing = this.writing.then(async () => {
      try {
        const before = await this.today();
        const after: DailyUsage = {
          day: before.day,
          bySource: { ...before.bySource, [source]: (before.bySource[source] ?? 0) + usd },
        };
        await this.deps.state.setUsage(after);
        this.warnOnCrossing(total(before), total(after));
      } catch (error) {
        this.deps.log.warn('recording model usage failed', { error: describeError(error) });
      }
    });
    return this.writing;
  }

  /** Today's spending so far. A new day starts empty (and the last one is logged). */
  async today(): Promise<DailyUsage> {
    const day = localDay(this.now(), this.deps.timeZone);
    const stored = await this.deps.state.usage();
    if (stored?.day === day) return stored;
    const fresh: DailyUsage = { day, bySource: {} };
    await this.deps.state.setUsage(fresh); // the day turns over (and is logged) once
    if (stored) {
      this.deps.log.info('daily model usage', {
        day: stored.day,
        usd: round(total(stored)),
        bySource: Object.fromEntries(
          Object.entries(stored.bySource).map(([source, usd]) => [source, round(usd)]),
        ),
      });
    }
    return fresh;
  }

  /** What agent-started work may still spend today (USD); undefined = no cap. */
  async budgetLeft(): Promise<number | undefined> {
    const { dailyBudgetUsd } = this.deps;
    if (dailyBudgetUsd === undefined) return undefined;
    return Math.max(0, dailyBudgetUsd - total(await this.today()));
  }

  private warnOnCrossing(before: number, after: number): void {
    const { dailyBudgetUsd, log } = this.deps;
    if (dailyBudgetUsd === undefined || before >= dailyBudgetUsd || after < dailyBudgetUsd) return;
    log.warn('daily model budget reached; agent-started work waits for tomorrow', {
      budgetUsd: dailyBudgetUsd,
      usd: round(after),
      note: 'answering people and channel triage go on',
    });
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }
}
