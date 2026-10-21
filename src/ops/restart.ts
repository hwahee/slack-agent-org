/**
 * The restart marker — how a shutting-down agent tells "restart" from "stop".
 *
 * Both arrive as the same SIGTERM. `bun run service:restart` leaves this file
 * in the data directory first; the agent reads it on the way out to pick its
 * Slack status (src/agent/status.ts) and clears it on the next start, so a
 * marker left by a restart that never reached the process cannot mislabel a
 * later shutdown for long.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

const MARKER = 'restart-requested';

/** Ignores markers older than this: a restart that did not happen. */
const MARKER_TTL_MS = 15 * 60_000;

export function restartMarkerPath(dataDir: string): string {
  return join(dataDir, MARKER);
}

export async function markRestart(dataDir: string, now = new Date()): Promise<void> {
  await Bun.write(restartMarkerPath(dataDir), now.toISOString());
}

export async function restartRequested(dataDir: string, now = new Date()): Promise<boolean> {
  const file = Bun.file(restartMarkerPath(dataDir));
  if (!(await file.exists())) return false;
  const at = Date.parse((await file.text()).trim());
  return Number.isFinite(at) && now.getTime() - at < MARKER_TTL_MS;
}

export async function clearRestart(dataDir: string): Promise<void> {
  await rm(restartMarkerPath(dataDir), { force: true });
}
