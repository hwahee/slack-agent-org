import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { silentLogger } from '../lib/log';
import { watchClock } from './clock';
import { validateRecord, validateSnapshot } from './events';
import { createFileDiagnostics, recordFileName } from './file';
import { createMemoryDiagnostics } from './memory';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'diag-'));
  dirs.push(dir);
  return dir;
}

/** A clock the test moves by hand. */
function handClock(start: string) {
  let wall = Date.parse(start);
  let mono = 1000;
  return {
    clock: { wall: () => new Date(wall), mono: () => mono },
    advance(ms: number) {
      wall += ms;
      mono += ms;
    },
  };
}

async function lines(path: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(path, 'utf8');
  return text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('contract', () => {
  test('a record with a field outside the contract is refused', () => {
    const diag = createMemoryDiagnostics();
    diag.record('heartbeat.beat', { outcome: 'working' });
    expect(validateRecord(diag.records[0])).toEqual({ ok: true });
    expect(validateRecord({ ...diag.records[0], text: '본문' }).ok).toBe(false);
    expect(validateRecord({ ...diag.records[0], kind: 'made.up' }).ok).toBe(false);
  });

  test('records are numbered within a boot', () => {
    const diag = createMemoryDiagnostics();
    diag.record('heartbeat.beat', { outcome: 'working' });
    diag.record('heartbeat.beat', { outcome: 'left', problem: 'slack connection down' });
    expect(diag.records.map((r) => r.seq)).toEqual([1, 2]);
    expect(new Set(diag.records.map((r) => r.boot)).size).toBe(1);
  });

  test('a section that throws drops only itself from the snapshot', () => {
    const diag = createMemoryDiagnostics();
    diag.section('inbox', () => ({ pending: 1, unseen: 1, oldestWaitingMs: 10 }));
    diag.section('turn', () => {
      throw new Error('broken');
    });
    const snapshot = diag.snapshot();
    expect(snapshot.sections.inbox?.pending).toBe(1);
    expect(snapshot.sections.turn).toBeUndefined();
    expect(validateSnapshot(snapshot)).toEqual({ ok: true });
  });
});

describe('file diagnostics', () => {
  test('appends records to one file per UTC day and writes the snapshot', async () => {
    const dir = await tempDir();
    const time = handClock('2026-11-25T23:59:59.000Z');
    const diag = createFileDiagnostics({
      dir,
      snapshotEveryMs: 60_000,
      retentionDays: 7,
      log: silentLogger,
      clock: time.clock,
      clockWatch: false,
    });
    diag.section('inbox', () => ({ pending: 0, unseen: 0, oldestWaitingMs: null }));
    diag.start();
    diag.record('heartbeat.beat', { outcome: 'working' });
    time.advance(2_000); // past midnight, UTC
    diag.record('heartbeat.beat', { outcome: 'left', problem: 'slack connection down' });
    await diag.stop();

    expect(await lines(join(dir, recordFileName('2026-11-25')))).toMatchObject([
      { kind: 'heartbeat.beat', outcome: 'working', seq: 1 },
    ]);
    const nextDay = await lines(join(dir, recordFileName('2026-11-26')));
    expect(nextDay).toMatchObject([{ kind: 'heartbeat.beat', outcome: 'left', seq: 2 }]);
    for (const line of nextDay) expect(validateRecord(line)).toEqual({ ok: true });

    const snapshot = JSON.parse(await readFile(join(dir, 'status.json'), 'utf8')) as unknown;
    expect(validateSnapshot(snapshot)).toEqual({ ok: true });
    expect(snapshot).toMatchObject({ diag: { records: 2, writeErrors: 0 } });
    expect((await readdir(dir)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  test('removes record files older than the retention, and nothing else', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, recordFileName('2026-11-01')), '');
    await writeFile(join(dir, recordFileName('2026-11-20')), '');
    await writeFile(join(dir, 'notes.txt'), 'keep me');
    const diag = createFileDiagnostics({
      dir,
      snapshotEveryMs: 60_000,
      retentionDays: 7,
      log: silentLogger,
      clock: handClock('2026-11-25T12:00:00.000Z').clock,
      clockWatch: false,
    });
    diag.record('heartbeat.beat', { outcome: 'working' });
    await diag.stop();

    expect((await readdir(dir)).sort()).toEqual(
      [
        recordFileName('2026-11-20'),
        recordFileName('2026-11-25'),
        'notes.txt',
        'status.json',
      ].sort(),
    );
  });

  test('a disk that refuses writes is counted, never thrown at the caller', async () => {
    const parent = await tempDir();
    const blocker = join(parent, 'not-a-folder');
    await writeFile(blocker, '');
    const warnings: string[] = [];
    const diag = createFileDiagnostics({
      dir: join(blocker, 'diag'), // cannot be created: its parent is a file
      snapshotEveryMs: 60_000,
      retentionDays: 7,
      log: { ...silentLogger, warn: (message) => warnings.push(message) },
      clockWatch: false,
    });
    diag.section('inbox', () => ({ pending: 0, unseen: 0, oldestWaitingMs: null }));
    expect(() => diag.record('heartbeat.beat', { outcome: 'working' })).not.toThrow();
    await diag.stop(); // never rejects
    expect(warnings).toEqual(['diagnostics: writing failed (the agent is unaffected)']);
  });
});

describe('clock watch', () => {
  test('a tick far later than asked is a gap; ordinary ticks are not', () => {
    let tick: () => void = () => undefined;
    let wall = 0;
    let mono = 0;
    const gaps: unknown[] = [];
    const stop = watchClock({
      everyMs: 1_000,
      gapMs: 5_000,
      onGap: (gap) => gaps.push(gap),
      wall: () => wall,
      mono: () => mono,
      setInterval: (fn) => {
        tick = fn;
        return 1;
      },
      clearInterval: () => undefined,
    });

    wall += 1_000;
    mono += 1_000;
    tick();
    expect(gaps).toEqual([]);

    // Asleep for a minute: the wall clock moved, the monotonic clock did not.
    wall += 60_000;
    mono += 1_000;
    tick();
    expect(gaps).toEqual([{ expectedMs: 1_000, wallElapsedMs: 60_000, monoElapsedMs: 1_000 }]);
    stop();
  });
});
