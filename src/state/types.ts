/**
 * What the agent keeps across turns and restarts.
 *
 *   - Each conversation's memory: the recent things said in it (by anyone,
 *     the agent included) and the notes the agent left itself at the end of
 *     its turns. Engines keep nothing between turns; this is what a turn is
 *     told, as text, instead of carrying every earlier screen and click.
 *   - The queue: messages not yet handled and turns paused at a safe point.
 *   - Until when the ears are known to have heard everything — where the next
 *     catch-up on missed messages starts.
 *   - Today's model spending (USD), so a daily budget survives restarts.
 */
import type { QueueSnapshot } from '../inbox/types';

/** One thing said in a conversation. */
interface Remark {
  readonly ts: string;
  /** Set when it was said inside a thread (equals `ts` for the thread root). */
  readonly threadTs?: string;
  readonly userName: string;
  readonly text: string;
  /** Said by the agent itself. */
  readonly own: boolean;
}

/** What the agent wrote down at the end of a turn: what it did, where things stand, what is left. */
interface WorkNote {
  /** UTC ISO time the turn ended. */
  readonly at: string;
  readonly text: string;
}

export interface ConversationMemory {
  /** Oldest first. */
  readonly remarks: readonly Remark[];
  /** Oldest first. */
  readonly notes: readonly WorkNote[];
}

/** Model spending on one local day. */
export interface DailyUsage {
  /** `YYYY-MM-DD` in TIME_ZONE. */
  readonly day: string;
  /** USD by what spent it (`turn`, `triage`, …). */
  readonly bySource: Readonly<Record<string, number>>;
}

export interface StateStore {
  memoryOf(conversation: string): Promise<ConversationMemory>;
  /** Every conversation remembered so far. */
  allMemories(): Promise<ReadonlyMap<string, ConversationMemory>>;
  remember(conversation: string, remark: Remark): Promise<void>;
  addNote(conversation: string, note: WorkNote): Promise<void>;
  loadQueue(): Promise<QueueSnapshot>;
  saveQueue(queue: QueueSnapshot): Promise<void>;
  /** UTC ISO time up to which everything said has been heard (or caught up on); unset at first. */
  heardUntil(): Promise<string | undefined>;
  setHeardUntil(at: string): Promise<void>;
  usage(): Promise<DailyUsage | undefined>;
  setUsage(usage: DailyUsage): Promise<void>;
}

export const EMPTY_QUEUE: QueueSnapshot = { pending: [], suspended: [] };

export const EMPTY_MEMORY: ConversationMemory = { remarks: [], notes: [] };

/** Remarks kept per conversation; older ones are forgotten. */
const REMARKS_KEPT = 40;
/** Work notes kept per conversation. */
const NOTES_KEPT = 5;
/** Longest remark or note kept, in characters. */
const TEXT_KEPT = 2000;

const cut = (text: string) => (text.length > TEXT_KEPT ? `${text.slice(0, TEXT_KEPT)}…` : text);

/** `memory` with `remark` added (once per `ts`), within the limits. */
export function withRemark(memory: ConversationMemory, remark: Remark): ConversationMemory {
  if (memory.remarks.some((r) => r.ts === remark.ts)) return memory;
  const remarks = [...memory.remarks, { ...remark, text: cut(remark.text) }]
    .sort((a, b) => Number(a.ts) - Number(b.ts))
    .slice(-REMARKS_KEPT);
  return { ...memory, remarks };
}

/** `memory` with `note` added, within the limits. */
export function withNote(memory: ConversationMemory, note: WorkNote): ConversationMemory {
  return {
    ...memory,
    notes: [...memory.notes, { ...note, text: cut(note.text) }].slice(-NOTES_KEPT),
  };
}
