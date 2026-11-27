/**
 * File diagnostics — the production driver.
 *
 *   <dir>/diag-YYYY-MM-DD.jsonl   records, one per line, appended (UTC days)
 *   <dir>/status.json             the status snapshot, replaced atomically
 *
 * Writes go through one queue so lines keep their order and a slow disk never
 * blocks the caller. If the queue backs up (a stuck disk), new lines are
 * dropped and counted rather than held in memory. Every failure is counted in
 * the snapshot (`diag.writeErrors`) and logged rarely; none ever reaches the
 * agent.
 */
import { appendFile, mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describeError, type Logger } from '../lib/log';
import { unrefed, watchClock } from './clock';
import type { DiagEvents, DiagKind, SnapshotSection, SnapshotSections } from './events';
import { Recorder, systemClock, type RecorderClock } from './recorder';
import type { DiagnosticsDriver } from './types';

export interface FileDiagnosticsOptions {
  readonly dir: string;
  readonly snapshotEveryMs: number;
  readonly retentionDays: number;
  readonly log: Logger;
  readonly clock?: RecorderClock;
  readonly pid?: number;
  /** The clock watch (./clock.ts); false turns it off (tests). */
  readonly clockWatch?: { everyMs: number; gapMs: number } | false;
}

/** Writes waiting beyond this are dropped (and counted). */
const MAX_PENDING_WRITES = 5_000;
/** The longest `stop()` waits for the queue to drain. */
const STOP_FLUSH_MS = 2_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RECORD_FILE = /^diag-(\d{4}-\d{2}-\d{2})\.jsonl$/;

export function recordFileName(day: string): string {
  return `diag-${day}.jsonl`;
}

export function createFileDiagnostics(options: FileDiagnosticsOptions): DiagnosticsDriver {
  const { dir, log } = options;
  const clock = options.clock ?? systemClock;
  const pid = options.pid ?? process.pid;
  const recorder = new Recorder(clock);

  let queue: Promise<void> = Promise.resolve();
  let pending = 0;
  let dirReady: Promise<unknown> | undefined;
  let day: string | undefined;
  let snapshotTimer: ReturnType<typeof setInterval> | undefined;
  let stopClock: (() => void) | undefined;

  function failed(what: string, error: unknown): void {
    recorder.writeErrors += 1;
    if (recorder.writeErrors === 1 || recorder.writeErrors % 100 === 0) {
      log.warn('diagnostics: writing failed (the agent is unaffected)', {
        what,
        failures: recorder.writeErrors,
        error: describeError(error),
      });
    }
  }

  function enqueue(what: string, write: () => Promise<void>): void {
    if (pending >= MAX_PENDING_WRITES) {
      failed(what, new Error('write queue full'));
      return;
    }
    pending += 1;
    queue = queue
      .then(async () => {
        dirReady ??= mkdir(dir, { recursive: true });
        await dirReady;
        await write();
      })
      .catch((error: unknown) => {
        dirReady = undefined; // the folder may have been removed; try again next time
        failed(what, error);
      })
      .finally(() => {
        pending -= 1;
      });
  }

  async function prune(today: string): Promise<void> {
    const oldest = Date.parse(today) - options.retentionDays * DAY_MS;
    for (const name of await readdir(dir)) {
      const match = RECORD_FILE.exec(name);
      if (match?.[1] && Date.parse(match[1]) < oldest) await unlink(join(dir, name));
    }
  }

  function writeSnapshot(): void {
    const body = `${JSON.stringify(recorder.snapshot(pid), null, 2)}\n`;
    enqueue('status.json', async () => {
      const path = join(dir, 'status.json');
      await writeFile(`${path}.tmp`, body);
      await rename(`${path}.tmp`, path);
    });
  }

  const driver: DiagnosticsDriver = {
    record<K extends DiagKind>(kind: K, fields: DiagEvents[K]): void {
      try {
        const line = recorder.line(kind, fields);
        const lineDay = line.t.slice(0, 10);
        if (lineDay !== day) {
          day = lineDay;
          enqueue('prune', () => prune(lineDay));
        }
        const text = `${JSON.stringify(line)}\n`;
        enqueue(kind, () => appendFile(join(dir, recordFileName(lineDay)), text));
      } catch (error) {
        failed(kind, error);
      }
    },

    section<K extends SnapshotSection>(name: K, read: () => SnapshotSections[K]): void {
      recorder.section(name, read);
    },

    start(): void {
      if (snapshotTimer) return;
      writeSnapshot();
      snapshotTimer = unrefed(setInterval(writeSnapshot, options.snapshotEveryMs));
      if (options.clockWatch !== false) {
        const watch = options.clockWatch ?? { everyMs: 1_000, gapMs: 5_000 };
        stopClock = watchClock({
          ...watch,
          onGap: (gap) => {
            recorder.lastGapAt = clock.wall().toISOString();
            driver.record('clock.gap', gap);
          },
        });
      }
    },

    async stop(): Promise<void> {
      if (snapshotTimer) clearInterval(snapshotTimer);
      snapshotTimer = undefined;
      stopClock?.();
      stopClock = undefined;
      writeSnapshot();
      await Promise.race([queue, Bun.sleep(STOP_FLUSH_MS)]);
    },
  };
  return driver;
}
