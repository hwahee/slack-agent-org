/**
 * The part both drivers share: numbering records, collecting the snapshot
 * sections and building the snapshot. Drivers decide only where lines go.
 */
import { randomUUID } from 'node:crypto';

import {
  DIAG_VERSION,
  type DiagEvents,
  type DiagKind,
  type DiagRecord,
  type SnapshotSection,
  type SnapshotSections,
  type StatusSnapshot,
} from './events';

export interface RecorderClock {
  readonly wall: () => Date;
  readonly mono: () => number;
}

export const systemClock: RecorderClock = {
  wall: () => new Date(),
  mono: () => performance.now(),
};

export class Recorder {
  readonly boot = `b-${randomUUID().slice(0, 8)}`;
  private seq = 0;
  private readonly sections = new Map<SnapshotSection, () => unknown>();
  lastGapAt: string | null = null;
  writeErrors = 0;

  constructor(private readonly clock: RecorderClock = systemClock) {}

  line<K extends DiagKind>(kind: K, fields: DiagEvents[K]): DiagRecord {
    this.seq += 1;
    return {
      v: DIAG_VERSION,
      t: this.clock.wall().toISOString(),
      mono: Math.round(this.clock.mono() * 10) / 10,
      boot: this.boot,
      seq: this.seq,
      kind,
      ...fields,
    };
  }

  section<K extends SnapshotSection>(name: K, read: () => SnapshotSections[K]): void {
    this.sections.set(name, read);
  }

  snapshot(pid: number): StatusSnapshot {
    const sections: Record<string, unknown> = {};
    for (const [name, read] of this.sections) {
      try {
        sections[name] = read();
      } catch {
        // A broken section drops only itself (types.ts: Diagnostics.section).
      }
    }
    return {
      v: DIAG_VERSION,
      writtenAt: this.clock.wall().toISOString(),
      mono: Math.round(this.clock.mono() * 10) / 10,
      boot: this.boot,
      pid,
      sections,
      clock: { lastGapAt: this.lastGapAt },
      diag: { records: this.seq, writeErrors: this.writeErrors },
    };
  }
}
