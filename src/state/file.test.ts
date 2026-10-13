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

const remark = (ts: string, text: string, own = false) => ({ ts, userName: '지훈', text, own });

describe('file state store', () => {
  test('starts empty when there is no file', async () => {
    const store = createFileStateStore(join(dir, 'state.json'));
    expect(await store.memoryOf('C1')).toEqual({ remarks: [], notes: [] });
    expect(await store.loadQueue()).toEqual({ pending: [], suspended: [] });
  });

  test('survives a restart', async () => {
    const path = join(dir, 'nested', 'state.json');
    const before = createFileStateStore(path);
    await before.remember('C1', remark('2.0', '두 번째'));
    await before.remember('C1', { ...remark('1.0', '첫 번째'), threadTs: '1.0' });
    await before.addNote('C1', { at: '2026-10-13T00:00:00.000Z', text: '답장함. 남은 일 없음' });
    await before.saveQueue({
      pending: [inboxMessage('1.0')],
      suspended: [{ conversation: 'C1', note: '초안 작성 중' }],
    });

    const after = createFileStateStore(path);
    expect(await after.memoryOf('C1')).toEqual({
      remarks: [{ ...remark('1.0', '첫 번째'), threadTs: '1.0' }, remark('2.0', '두 번째')],
      notes: [{ at: '2026-10-13T00:00:00.000Z', text: '답장함. 남은 일 없음' }],
    });
    expect(await after.loadQueue()).toEqual({
      pending: [inboxMessage('1.0')],
      suspended: [{ conversation: 'C1', note: '초안 작성 중' }],
    });
  });

  test('remembers a message once, and only the recent ones', async () => {
    const store = createFileStateStore(join(dir, 'state.json'));
    await store.remember('C1', remark('1.0', '한 번'));
    await store.remember('C1', remark('1.0', '한 번'));
    expect((await store.memoryOf('C1')).remarks).toHaveLength(1);

    for (let i = 2; i <= 60; i++) await store.remember('C1', remark(`${i}.0`, `#${i}`));
    const { remarks } = await store.memoryOf('C1');
    expect(remarks).toHaveLength(40);
    expect(remarks.at(-1)?.text).toBe('#60');

    for (let i = 1; i <= 7; i++) await store.addNote('C1', { at: `t${i}`, text: `note ${i}` });
    expect((await store.memoryOf('C1')).notes.map((n) => n.text)).toEqual([
      'note 3',
      'note 4',
      'note 5',
      'note 6',
      'note 7',
    ]);
  });

  test('serializes concurrent writes', async () => {
    const path = join(dir, 'state.json');
    const store = createFileStateStore(path);
    await Promise.all([
      store.remember('A', remark('1.0', 'a')),
      store.remember('B', remark('1.0', 'b')),
    ]);
    const reread = createFileStateStore(path);
    expect([
      (await reread.memoryOf('A')).remarks[0]?.text,
      (await reread.memoryOf('B')).remarks[0]?.text,
    ]).toEqual(['a', 'b']);
  });

  test('reads a version 1 file, keeping the queue and dropping the old sessions', async () => {
    const path = join(dir, 'state.json');
    await Bun.write(
      path,
      JSON.stringify({
        version: 1,
        sessions: { D1: 'old-session' },
        queue: { pending: [inboxMessage('1.0')], suspended: [] },
      }),
    );
    const store = createFileStateStore(path);
    expect(await store.loadQueue()).toEqual({ pending: [inboxMessage('1.0')], suspended: [] });
    expect(await store.memoryOf('D1')).toEqual({ remarks: [], notes: [] });
  });

  test('refuses a corrupted file instead of starting over silently', async () => {
    const path = join(dir, 'state.json');
    await Bun.write(path, JSON.stringify({ version: 99 }));
    await expect(createFileStateStore(path).memoryOf('C1')).rejects.toThrow();
  });
});
