import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearRestart, markRestart, restartMarkerPath, restartRequested } from './restart';

describe('restart marker', () => {
  test('a fresh marker means restart; clearing it, or age, means stop', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'restart-'));
    expect(await restartRequested(dir)).toBe(false);

    const at = new Date('2026-10-20T10:00:00.000Z');
    await markRestart(dir, at);
    expect(await restartRequested(dir, new Date('2026-10-20T10:05:00.000Z'))).toBe(true);
    expect(await restartRequested(dir, new Date('2026-10-20T10:20:00.000Z'))).toBe(false);

    await clearRestart(dir);
    expect(await restartRequested(dir, at)).toBe(false);
    await clearRestart(dir); // fine when already gone
  });

  test('an unreadable marker is not a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'restart-'));
    await Bun.write(restartMarkerPath(dir), 'garbage');
    expect(await restartRequested(dir)).toBe(false);
  });
});
