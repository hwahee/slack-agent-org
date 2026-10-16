/**
 * State in one JSON file (`<DATA_DIR>/state.json`).
 *
 * One agent per machine and one process per agent, so a file is enough. Every
 * write replaces the file atomically (write a temp file, then rename), and
 * writes are serialized, so a crash leaves either the old state or the new one.
 *
 * Version 1 kept an engine session per conversation; those sessions are no
 * longer continued, so a version 1 file is read as version 2 without them.
 */
import { mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { QueueSnapshot } from '../inbox/types';
import { s, toValidator, type Infer } from '../validation';
import {
  EMPTY_MEMORY,
  withNote,
  withRemark,
  type ConversationMemory,
  type StateStore,
} from './types';

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
  triage: s.optional(s.object({ reason: s.string() })),
});

const queue = s.object({
  pending: s.array(inboxMessage),
  suspended: s.array(s.object({ conversation: s.string(), note: s.string() })),
});

const memory = s.object({
  remarks: s.array(
    s.object({
      ts: s.string(),
      threadTs: s.optional(s.string()),
      userName: s.string(),
      text: s.string(),
      own: s.boolean(),
    }),
  ),
  notes: s.array(s.object({ at: s.string(), text: s.string() })),
});

const stateValidator = toValidator(
  s.object({
    version: s.literal(2),
    conversations: s.record(s.string(), memory),
    queue,
  }),
);

const versionOneValidator = toValidator(
  s.object({ version: s.literal(1), sessions: s.record(s.string(), s.string()), queue }),
);

type StateFile = Infer<typeof stateValidator>;

const EMPTY: StateFile = { version: 2, conversations: {}, queue: { pending: [], suspended: [] } };

/** The file's own (mutable) copy of a conversation's memory. */
function stored(memory: ConversationMemory): StateFile['conversations'][string] {
  return { remarks: [...memory.remarks], notes: [...memory.notes] };
}

function parse(json: unknown): StateFile {
  const old = versionOneValidator.safeParse(json);
  if (old.ok) return { version: 2, conversations: {}, queue: old.value.queue };
  return stateValidator.parse(json);
}

export function createFileStateStore(path: string): StateStore {
  let state: Promise<StateFile> | undefined;
  let writing: Promise<void> = Promise.resolve();

  function read(): Promise<StateFile> {
    state ??= (async () => {
      const file = Bun.file(path);
      if (!(await file.exists())) return structuredClone(EMPTY);
      return parse(await file.json());
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
    async memoryOf(conversation): Promise<ConversationMemory> {
      return (await read()).conversations[conversation] ?? EMPTY_MEMORY;
    },
    remember(conversation, remark) {
      return update((current) => {
        current.conversations[conversation] = stored(
          withRemark(current.conversations[conversation] ?? EMPTY_MEMORY, remark),
        );
      });
    },
    addNote(conversation, note) {
      return update((current) => {
        current.conversations[conversation] = stored(
          withNote(current.conversations[conversation] ?? EMPTY_MEMORY, note),
        );
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
