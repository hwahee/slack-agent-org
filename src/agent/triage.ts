/**
 * Triage — a glance at the channel messages nobody addressed to the agent.
 *
 * A person in a channel does not answer only when mentioned: they skim the
 * notifications and chime in when something is theirs to answer. Triage is
 * that skim. Overheard messages (../inbox/addressing.ts) gather per channel
 * for a short while, then one tool-less call to the judge — usually a small
 * model — decides whether the agent should answer. If so, the messages join
 * the inbox like any other (behind the ones addressed to it) and reach the
 * agent through the same cooperative path: a badge while it works, a turn
 * when it is free. If not, the reason is logged and nothing else happens.
 *
 * A glance is not a turn: it never touches the desk, so it runs beside the
 * turn in progress. Glances run one at a time. When in doubt — an unreadable
 * answer, a failed call — the agent stays quiet.
 */
import type { Judge } from '../engine/types';
import type { Inbox } from '../inbox/inbox';
import type { InboxMessage } from '../inbox/types';
import { describeError, type Logger } from '../lib/log';
import type { StateStore } from '../state/types';
import { s, toValidator } from '../validation';
import { triagePrompt } from './prompts';

export interface TriageDeps {
  readonly judge: Judge;
  readonly inbox: Inbox;
  readonly state: Pick<StateStore, 'memoryOf'>;
  /** Messages from anyone else are judged more conservatively (they are agents). */
  readonly humanUserIds: readonly string[];
  readonly timeZone: string;
  /** How long a channel's overheard messages gather before one glance at them all. */
  readonly waitMs: number;
  readonly log: Logger;
}

export interface Decision {
  readonly respond: boolean;
  /** The messages to answer — only those among the ones judged. */
  readonly ids: readonly string[];
  readonly reason: string;
}

const answerValidator = toValidator(
  s.object({
    respond: s.boolean(),
    ids: s.optional(s.array(s.string())),
    reason: s.optional(s.string()),
  }),
);

/**
 * The judge's answer → a decision, or null when it cannot be read.
 * "Respond" without ids means all of the judged messages.
 */
export function readDecision(text: string, judged: readonly string[]): Decision | null {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (!json) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = answerValidator.safeParse(value);
  if (!parsed.ok) return null;
  const { respond, ids = [], reason = '' } = parsed.value;
  const picked = judged.filter((id) => ids.includes(id));
  return {
    respond,
    ids: respond ? (picked.length > 0 ? picked : [...judged]) : [],
    reason: reason.trim() || '(이유 없음)',
  };
}

interface Gathering {
  readonly messages: InboxMessage[];
  readonly timer: ReturnType<typeof setTimeout>;
}

export class Triage {
  private readonly gathering = new Map<string, Gathering>();
  private readonly humans: ReadonlySet<string>;
  /** The glance in progress (and those queued behind it). Never rejects. */
  private glancing: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly deps: TriageDeps) {
    this.humans = new Set(deps.humanUserIds);
  }

  /** An overheard message: gather it with the rest of its channel's, then glance. */
  consider(message: InboxMessage): void {
    if (this.stopped) return;
    const gathering = this.gathering.get(message.conversation);
    if (gathering) {
      gathering.messages.push(message);
      return;
    }
    const timer = setTimeout(() => void this.glanceAt(message.conversation), this.deps.waitMs);
    this.gathering.set(message.conversation, { messages: [message], timer });
  }

  /** Glances at everything gathered so far, without waiting out the gathering time. */
  async flush(): Promise<void> {
    await Promise.all(
      [...this.gathering.keys()].map((conversation) => this.glanceAt(conversation)),
    );
  }

  /**
   * Stops gathering. Messages not yet glanced at are dropped (they stay in the
   * conversation's memory); a glance already in progress finishes first, so
   * whatever it lets through is in the inbox before the queue is saved.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    const dropped = [...this.gathering.values()].reduce((n, g) => n + g.messages.length, 0);
    for (const { timer } of this.gathering.values()) clearTimeout(timer);
    this.gathering.clear();
    if (dropped > 0) this.deps.log.info('triage stopped; overheard messages dropped', { dropped });
    await this.glancing;
  }

  private glanceAt(conversation: string): Promise<void> {
    const gathering = this.gathering.get(conversation);
    if (!gathering) return this.glancing;
    clearTimeout(gathering.timer);
    this.gathering.delete(conversation);
    this.glancing = this.glancing.then(() => this.glance(conversation, gathering.messages));
    return this.glancing;
  }

  private async glance(conversation: string, messages: readonly InboxMessage[]): Promise<void> {
    if (this.stopped) return;
    const { judge, inbox, state, timeZone, log } = this.deps;
    const started = Date.now();
    try {
      const memory = await state.memoryOf(conversation);
      const candidates = messages.map((message) => ({
        message,
        fromHuman: this.humans.has(message.user),
      }));
      const answer = await judge.ask(triagePrompt(candidates, timeZone, memory));
      const decision = readDecision(
        answer.text,
        messages.map((m) => m.id),
      );
      const fields = {
        conversation,
        judged: messages.map((m) => m.id),
        ms: Date.now() - started,
        costUsd: answer.costUsd,
      };
      if (!decision) {
        log.warn('triage answer unreadable; staying quiet', {
          ...fields,
          answer: answer.text.slice(0, 300),
        });
        return;
      }
      if (!decision.respond) {
        log.info('triage: staying quiet', { ...fields, reason: decision.reason });
        return;
      }
      for (const message of messages) {
        if (decision.ids.includes(message.id)) {
          inbox.push({ ...message, triage: { reason: decision.reason } });
        }
      }
      log.info('triage: will answer', { ...fields, ids: decision.ids, reason: decision.reason });
    } catch (error) {
      log.error('triage failed; staying quiet', { conversation, error: describeError(error) });
    }
  }
}
