import { describe, expect, test } from 'bun:test';

import { silentLogger } from '../lib/log';
import { createMemoryStateStore } from '../state/memory';
import { Poller, type PollContext, type PollTask } from './poller';
import { UsageLedger } from './usage';

const usage = new UsageLedger({
  state: createMemoryStateStore(),
  timeZone: 'Asia/Seoul',
  log: silentLogger,
});

function task(name: string, run: (context: PollContext) => Promise<void> | void): PollTask {
  return { name, run: async (context) => run(context) };
}

describe('Poller', () => {
  test('runs every task in order, now and then every interval', async () => {
    const ran: string[] = [];
    const poller = new Poller({
      tasks: [task('a', () => void ran.push('a')), task('b', () => void ran.push('b'))],
      intervalMs: 20,
      usage,
      log: silentLogger,
    });
    poller.start();
    await Bun.sleep(50);
    await poller.stop();

    expect(ran.slice(0, 4)).toEqual(['a', 'b', 'a', 'b']);
    const count = ran.length;
    await Bun.sleep(40);
    expect(ran).toHaveLength(count); // stopped for good
  });

  test('a failing task does not stop the others', async () => {
    const ran: string[] = [];
    const errors: string[] = [];
    const poller = new Poller({
      tasks: [
        task('broken', () => {
          throw new Error('boom');
        }),
        task('fine', () => void ran.push('fine')),
      ],
      intervalMs: 60_000,
      usage,
      log: { ...silentLogger, error: (message) => errors.push(message) },
    });
    await poller.poll();
    expect(ran).toEqual(['fine']);
    expect(errors).toEqual(['poll task failed']);
  });

  test('never overlaps a poll still running, and stop waits for it', async () => {
    let release = () => undefined as void;
    let runs = 0;
    let finished = false;
    const poller = new Poller({
      tasks: [
        task('slow', async () => {
          runs += 1;
          await new Promise<void>((resolve) => (release = resolve));
          finished = true;
        }),
      ],
      intervalMs: 60_000,
      usage,
      log: silentLogger,
    });
    const first = poller.poll();
    const second = poller.poll();
    expect(runs).toBe(1);

    const stopped = poller.stop();
    release();
    await Promise.all([first, second, stopped]);
    expect(finished).toBe(true);
  });

  test('hands tasks the poll time, chance and the usage ledger', async () => {
    let seen: PollContext | undefined;
    const at = new Date('2026-10-22T06:30:00.000Z');
    const poller = new Poller({
      tasks: [task('look', (context) => void (seen = context))],
      intervalMs: 60_000,
      usage,
      log: silentLogger,
      now: () => at,
      random: () => 0.25,
    });
    await poller.poll();
    expect(seen?.now).toBe(at);
    expect(seen?.random()).toBe(0.25);
    expect(await seen?.usage.budgetLeft()).toBeUndefined();
  });
});
