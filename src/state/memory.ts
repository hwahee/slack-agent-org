import type { QueueSnapshot } from '../inbox/types';
import { EMPTY_QUEUE, type StateStore } from './types';

/** State that lives as long as the process — for tests. */
export function createMemoryStateStore(): StateStore {
  const sessions = new Map<string, string>();
  let queue: QueueSnapshot = EMPTY_QUEUE;
  return {
    sessionOf: (conversation) => Promise.resolve(sessions.get(conversation)),
    saveSession(conversation, sessionId) {
      sessions.set(conversation, sessionId);
      return Promise.resolve();
    },
    loadQueue: () => Promise.resolve(queue),
    saveQueue(next) {
      queue = next;
      return Promise.resolve();
    },
  };
}
