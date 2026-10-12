/**
 * What the agent keeps across restarts.
 *
 *   - Which engine session belongs to which conversation, so a channel or a DM
 *     picks up where it left off.
 *   - The queue: messages not yet handled and turns paused at a safe point.
 */
import type { QueueSnapshot } from '../inbox/types';

export interface StateStore {
  sessionOf(conversation: string): Promise<string | undefined>;
  saveSession(conversation: string, sessionId: string): Promise<void>;
  loadQueue(): Promise<QueueSnapshot>;
  saveQueue(queue: QueueSnapshot): Promise<void>;
}

export const EMPTY_QUEUE: QueueSnapshot = { pending: [], suspended: [] };
