/**
 * State in one JSON file (`<DATA_DIR>/state.json`).
 *
 * One agent per machine and one process per agent, so a file is enough. Every
 * write replaces the file atomically (write a temp file, then rename), and
 * writes are serialized, so a crash leaves either the old state or the new one.
 */
import { mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { QueueSnapshot } from '../inbox/types';
import { s, toValidator, type Infer } from '../validation';
import type { StateStore } from './types';

const inboxMessage = s.object({
  id: s.string(),
  conversation: s.string(),
  channel: s.string(),
  channelType: s.enum(['im', 'mpim', 'channel', 'group']),
  channelName: s.string(),
  ts: s.string(),
  threadTs: s.optional(s.string()),
  user: s.string(),
  userName: s.string(),
  text: s.string(),
  receivedAt: s.string(),
});

const stateValidator = toValidator(
  s.object({
    version: s.literal(1),
    sessions: s.record(s.string(), s.string()),
    queue: s.object({
      pending: s.array(inboxMessage),
      suspended: s.array(s.object({ conversation: s.string(), note: s.string() })),
    }),
  }),
);

type StateFile = Infer<typeof stateValidator>;

const EMPTY: StateFile = { version: 1, sessions: {}, queue: { pending: [], suspended: [] } };

export function createFileStateStore(path: string): StateStore {
  let state: Promise<StateFile> | undefined;
  let writing: Promise<void> = Promise.resolve();

  function read(): Promise<StateFile> {
    state ??= (async () => {
      const file = Bun.file(path);
      if (!(await file.exists())) return structuredClone(EMPTY);
      return stateValidator.parse(await file.json());
    })();
    return state;
  }

  function update(change: (current: StateFile) => void): Promise<void> {
    // A failed write fails its caller, not every write after it.
    const next = writing
      .catch(() => undefined)
      .then(async () => {
        const current = await read();
        change(current);
        await mkdir(dirname(path), { recursive: true });
        const temp = `${path}.tmp`;
        await Bun.write(temp, JSON.stringify(current, null, 2));
        await rename(temp, path);
      });
    writing = next;
    return next;
  }

  return {
    async sessionOf(conversation) {
      return (await read()).sessions[conversation];
    },
    saveSession(conversation, sessionId) {
      return update((current) => {
        current.sessions[conversation] = sessionId;
      });
    },
    async loadQueue(): Promise<QueueSnapshot> {
      return (await read()).queue;
    },
    saveQueue(queue) {
      return update((current) => {
        current.queue = { pending: [...queue.pending], suspended: [...queue.suspended] };
      });
    },
  };
}
