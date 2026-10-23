import { describe, expect, test } from 'bun:test';

import { silentLogger } from '../lib/log';
import { createMemoryStateStore } from '../state/memory';
import { localDay, UsageLedger } from './usage';

function setup(dailyBudgetUsd?: number) {
  let now = new Date('2026-10-22T06:30:00.000Z'); // 15:30 in Seoul
  const logged: { message: string; fields?: Record<string, unknown> }[] = [];
  const log = {
    ...silentLogger,
    info: (message: string, fields?: Record<string, unknown>) => logged.push({ message, fields }),
    warn: (message: string, fields?: Record<string, unknown>) => logged.push({ message, fields }),
  };
  const state = createMemoryStateStore();
  const ledger = new UsageLedger({
    state,
    timeZone: 'Asia/Seoul',
    ...(dailyBudgetUsd !== undefined && { dailyBudgetUsd }),
    log,
    now: () => now,
  });
  return { ledger, state, logged, setNow: (date: Date) => (now = date) };
}

describe('localDay', () => {
  test('is the day in the given time zone', () => {
    expect(localDay(new Date('2026-10-22T15:30:00.000Z'), 'Asia/Seoul')).toBe('2026-10-23');
  });
});

describe('UsageLedger', () => {
  test('tallies the day by source and ignores unknown costs', async () => {
    const { ledger, state } = setup();
    await ledger.record('turn', 0.1);
    await ledger.record('turn', 0.05);
    await ledger.record('triage', 0.002);
    await ledger.record('turn', undefined);
    const usage = await state.usage();
    expect(usage?.day).toBe('2026-10-22');
    expect(usage?.bySource.turn).toBeCloseTo(0.15);
    expect(usage?.bySource.triage).toBeCloseTo(0.002);
    expect(await ledger.budgetLeft()).toBeUndefined(); // no cap set
  });

  test('a new day starts empty and the last one is logged once', async () => {
    const { ledger, logged, setNow } = setup();
    await ledger.record('turn', 0.3);
    setNow(new Date('2026-10-22T15:30:00.000Z')); // past midnight in Seoul
    expect(await ledger.today()).toEqual({ day: '2026-10-23', bySource: {} });
    await ledger.today();
    expect(logged.filter((l) => l.message === 'daily model usage')).toEqual([
      {
        message: 'daily model usage',
        fields: { day: '2026-10-22', usd: 0.3, bySource: { turn: 0.3 } },
      },
    ]);
  });

  test('the budget is what is left today, and crossing it is logged once', async () => {
    const { ledger, logged } = setup(1);
    await ledger.record('turn', 0.6);
    expect(await ledger.budgetLeft()).toBeCloseTo(0.4);
    await ledger.record('triage', 0.5);
    await ledger.record('turn', 0.5);
    expect(await ledger.budgetLeft()).toBe(0);
    expect(logged.filter((l) => l.message.startsWith('daily model budget reached'))).toHaveLength(
      1,
    );
  });
});
