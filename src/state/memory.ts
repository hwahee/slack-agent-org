import type { QueueSnapshot } from '../inbox/types';
import {
  EMPTY_MEMORY,
  EMPTY_QUEUE,
  withNote,
  withRemark,
  type ConversationMemory,
  type StateStore,
} from './types';

/** State that lives as long as the process — for tests. */
export function createMemoryStateStore(): StateStore {
  const memories = new Map<string, ConversationMemory>();
  let queue: QueueSnapshot = EMPTY_QUEUE;
  const memoryOf = (conversation: string) => memories.get(conversation) ?? EMPTY_MEMORY;
  return {
    memoryOf: (conversation) => Promise.resolve(memoryOf(conversation)),
    remember(conversation, remark) {
      memories.set(conversation, withRemark(memoryOf(conversation), remark));
      return Promise.resolve();
    },
    addNote(conversation, note) {
      memories.set(conversation, withNote(memoryOf(conversation), note));
      return Promise.resolve();
    },
    loadQueue: () => Promise.resolve(queue),
    saveQueue(next) {
      queue = next;
      return Promise.resolve();
    },
  };
}
