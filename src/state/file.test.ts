import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { inboxMessage } from '../testing/fixtures';
import { createFileStateStore } from './file';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'state-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('file state store', () => {
  test('starts empty when there is no file', async () => {
    const store = createFileStateStore(join(dir, 'state.json'));
    expect(await store.sessionOf('C1')).toBeUndefined();
    expect(await store.loadQueue()).toEqual({ pending: [], suspended: [] });
  });

  test('survives a restart', async () => {
    const path = join(dir, 'nested', 'state.json');
    const before = createFileStateStore(path);
    await before.saveSession('C1', 'session-1');
    await before.saveQueue({
      pending: [inboxMessage('1.0')],
      suspended: [{ conversation: 'C1', note: '초안 작성 중' }],
    });

    const after = createFileStateStore(path);
    expect(await after.sessionOf('C1')).toBe('session-1');
    expect(await after.loadQueue()).toEqual({
      pending: [inboxMessage('1.0')],
      suspended: [{ conversation: 'C1', note: '초안 작성 중' }],
    });
  });

  test('serializes concurrent writes', async () => {
    const path = join(dir, 'state.json');
    const store = createFileStateStore(path);
    await Promise.all([store.saveSession('A', '1'), store.saveSession('B', '2')]);
    const reread = createFileStateStore(path);
    expect([await reread.sessionOf('A'), await reread.sessionOf('B')]).toEqual(['1', '2']);
  });

  test('refuses a corrupted file instead of starting over silently', async () => {
    const path = join(dir, 'state.json');
    await Bun.write(path, JSON.stringify({ version: 99 }));
    await expect(createFileStateStore(path).sessionOf('C1')).rejects.toThrow();
  });
});
