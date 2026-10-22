/**
 * The agent runtime — one agent, one desk, one turn at a time.
 *
 * Every turn starts the engine afresh. The runtime owns what the agent
 * remembers of a conversation (what was said, and the note the agent left at
 * the end of each turn) and tells it as text at the start of the next turn.
 *
 * Loop:
 *   1. The oldest waiting conversation gets a turn (all of its waiting
 *      messages at once).
 *   2. With nothing waiting, the most recently paused task resumes.
 *   3. With nothing at all, it sleeps until the ears hear something.
 *
 * A turn is never cut short (CLAUDE.md). While it runs, new messages only
 * queue up; the agent sees a badge and pauses itself at a safe point if it
 * chooses (`requestYield`, from the inbox_yield tool). Stopping the runtime
 * (shutdown) likewise waits for the turn in progress to end.
 */
import type { Engine } from '../engine/types';
import type { Inbox } from '../inbox/inbox';
import type { QueueSnapshot, SuspendedTurn } from '../inbox/types';
import { describeError, type Logger } from '../lib/log';
import type { ConversationMemory, StateStore } from '../state/types';
import type { TurnControl } from '../tools/types';
import { messagesPrompt, resumePrompt } from './prompts';
import type { UsageLedger } from './usage';

export interface RuntimeDeps {
  readonly inbox: Inbox;
  readonly engine: Engine;
  readonly state: StateStore;
  readonly timeZone: string;
  readonly log: Logger;
  /** Pause after a failed turn, so a broken engine does not spin. */
  readonly failureBackoffMs?: number;
  /** Where each turn's cost is tallied. */
  readonly usage?: Pick<UsageLedger, 'record'>;
}

interface CurrentTurn {
  readonly conversation: string;
  yieldNote?: string;
}

export class AgentRuntime implements TurnControl {
  private current: CurrentTurn | null = null;
  /** Paused tasks; the last one paused resumes first, like a stack of interrupted work. */
  private suspended: SuspendedTurn[] = [];
  private failing = 0;

  constructor(private readonly deps: RuntimeDeps) {}

  requestYield(note: string): boolean {
    if (!this.current) return false;
    this.current.yieldNote = note;
    this.deps.log.info('agent pausing its task', { conversation: this.current.conversation, note });
    return true;
  }

  /** Turns in a row that failed or ended in an error (0 after any turn that went fine). */
  get failingTurns(): number {
    return this.failing;
  }

  /** Puts back what a previous process left (call before `run`). */
  restore(queue: QueueSnapshot): void {
    this.deps.inbox.restore(queue.pending);
    this.suspended = [...queue.suspended];
  }

  /** What a restart must not lose. */
  snapshot(): QueueSnapshot {
    return { pending: this.deps.inbox.snapshot(), suspended: [...this.suspended] };
  }

  /** Runs until `signal` aborts, then returns once the turn in progress has ended. */
  async run(signal: AbortSignal): Promise<void> {
    const { inbox } = this.deps;
    while (!signal.aborted) {
      const { timeZone } = this.deps;
      const batch = inbox.takeNextConversation();
      if (batch) {
        await this.turn(batch.conversation, (memory) =>
          messagesPrompt(batch.messages, timeZone, memory),
        );
        continue;
      }
      const paused = this.suspended.pop();
      if (paused) {
        await this.turn(paused.conversation, (memory) =>
          resumePrompt(paused.note, timeZone, memory),
        );
        continue;
      }
      await inbox.waitForMessage(signal);
    }
  }

  private async turn(
    conversation: string,
    prompt: (memory: ConversationMemory) => string,
  ): Promise<void> {
    const { engine, state, log } = this.deps;
    const current: CurrentTurn = { conversation };
    this.current = current;
    const started = Date.now();
    try {
      const memory = await state.memoryOf(conversation);
      const result = await engine.run({ prompt: prompt(memory) });
      void this.deps.usage?.record('turn', result.costUsd);
      this.failing = result.ok ? 0 : this.failing + 1;
      if (result.summary.trim()) {
        await state.addNote(conversation, {
          at: new Date().toISOString(),
          text: result.summary.trim(),
        });
      }

      const fields = {
        conversation,
        sessionId: result.sessionId,
        ms: Date.now() - started,
        costUsd: result.costUsd,
        toolRoundTrips: result.toolRoundTrips,
        summary: result.summary,
      };
      if (result.ok) log.info('turn finished', fields);
      else log.warn('turn ended with an error', fields);

      if (current.yieldNote !== undefined) {
        this.suspended.push({ conversation, note: current.yieldNote });
      }
    } catch (error) {
      this.failing += 1;
      log.error('turn failed', { conversation, error: describeError(error) });
      await Bun.sleep(this.deps.failureBackoffMs ?? 5_000);
    } finally {
      this.current = null;
      await state.saveQueue(this.snapshot()).catch((error: unknown) => {
        log.error('saving the queue failed', { error: describeError(error) });
      });
    }
  }
}
