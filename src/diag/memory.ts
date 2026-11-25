/**
 * Memory diagnostics — for tests: records are kept in an array and the
 * snapshot is built on demand.
 */
import type {
  DiagEvents,
  DiagKind,
  DiagRecord,
  SnapshotSection,
  SnapshotSections,
  StatusSnapshot,
} from './events';
import { Recorder } from './recorder';
import type { DiagnosticsDriver } from './types';

export interface MemoryDiagnostics extends DiagnosticsDriver {
  readonly records: DiagRecord[];
  /** Records of one kind, fields only. */
  of<K extends DiagKind>(kind: K): (DiagRecord & DiagEvents[K])[];
  snapshot(): StatusSnapshot;
}

export function createMemoryDiagnostics(): MemoryDiagnostics {
  const recorder = new Recorder();
  const records: DiagRecord[] = [];
  return {
    records,
    record<K extends DiagKind>(kind: K, fields: DiagEvents[K]): void {
      records.push(recorder.line(kind, fields));
    },
    section<K extends SnapshotSection>(name: K, read: () => SnapshotSections[K]): void {
      recorder.section(name, read);
    },
    of<K extends DiagKind>(kind: K) {
      return records.filter((r) => r.kind === kind) as (DiagRecord & DiagEvents[K])[];
    },
    snapshot: () => recorder.snapshot(process.pid),
    start: () => undefined,
    stop: () => Promise.resolve(),
  };
}
