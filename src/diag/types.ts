/**
 * Diagnostics — the port every part of the agent writes to.
 *
 * Diagnostics only WRITE DOWN what they are told (CLAUDE.md: diagnostics
 * observe only). They never change what the agent does: recording is cheap and
 * synchronous for the caller, never throws, never sends anything anywhere and
 * never waits for a disk. With `DIAG=off` the agent gets {@link noopDiagnostics}
 * and behaves exactly the same.
 *
 * What a record and the status snapshot look like: ./events.ts (the contract)
 * and docs/diagnostics.md.
 */
import type { DiagEvents, DiagKind, SnapshotSection, SnapshotSections } from './events';

export interface Diagnostics {
  /** Writes one record. Never throws. */
  record<K extends DiagKind>(kind: K, fields: DiagEvents[K]): void;
  /**
   * Adds a part of the status snapshot (`status.json`). `read` is called at
   * every snapshot; it must be cheap and must not throw (a throw drops only
   * that part of that snapshot).
   */
  section<K extends SnapshotSection>(name: K, read: () => SnapshotSections[K]): void;
}

/** The process-level side: the container starts and stops it. */
export interface DiagnosticsDriver extends Diagnostics {
  /** Starts the snapshot timer and the clock watch. Idempotent. */
  start(): void;
  /** Stops the timers, writes a last snapshot and flushes. Bounded in time; never rejects. */
  stop(): Promise<void>;
}

export const noopDiagnostics: DiagnosticsDriver = {
  record: () => undefined,
  section: () => undefined,
  start: () => undefined,
  stop: () => Promise.resolve(),
};
