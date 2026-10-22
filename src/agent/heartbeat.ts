/**
 * The heartbeat — the agent's Slack status as proof of life.
 *
 * On every poll, if the agent is fine (it can hear Slack, its desk works,
 * its turns are not failing), the status becomes "근무 중 · 15:30 확인"
 * (HEARTBEAT_TEXT). Anyone glancing at the agent's name sees when it was last
 * known to be fine; a time that stops moving means something is wrong — the
 * process died, the machine slept, or a check below is failing.
 *
 * - The desk lacks a macOS permission → the "permission needed" status
 *   (set once, not on every poll): a person has to act.
 * - Anything else is wrong → the status is left alone, so the time stops.
 *
 * Plain code and one API call (src/slack/status.ts); no model, no desk.
 */
import { describeError, type Logger } from '../lib/log';
import type { SlackStatus, StatusLook } from '../slack/types';
import type { PollContext, PollTask } from './poller';
import { heartbeatLook, STATUS_LOOKS } from './status';

export interface HeartbeatDeps {
  readonly status: SlackStatus;
  /** Why the desk cannot see or act (a missing macOS permission), or undefined. */
  readonly deskProblem: () => Promise<string | undefined>;
  /** Anything else that keeps the agent from being fine (ears down, turns failing), or undefined. */
  readonly otherProblem: () => string | undefined;
  /** HEARTBEAT_TEXT: `{time}`, `{date}`. */
  readonly template: string;
  readonly timeZone: string;
  readonly log: Logger;
}

export class Heartbeat implements PollTask {
  readonly name = 'heartbeat';
  /** What this process last showed — so "permission needed" is set once, not every poll. */
  private shown: 'working' | 'blocked' | undefined;

  constructor(private readonly deps: HeartbeatDeps) {}

  run(context: PollContext): Promise<void> {
    return this.beat(context.now);
  }

  /** Checks the agent and shows the result. Never rejects. */
  async beat(at: Date = new Date()): Promise<void> {
    const { deskProblem, otherProblem, template, timeZone, log } = this.deps;
    try {
      const desk = await deskProblem();
      if (desk) {
        if (this.shown !== 'blocked') await this.show('blocked', STATUS_LOOKS.blocked);
        return;
      }
      const problem = otherProblem();
      if (problem) {
        log.warn('heartbeat: not fine; the status time is left where it was', { problem });
        return;
      }
      await this.show('working', heartbeatLook(template, at, timeZone));
    } catch (error) {
      log.warn('heartbeat failed', { error: describeError(error) });
    }
  }

  private async show(shown: 'working' | 'blocked', look: StatusLook): Promise<void> {
    await this.deps.status.set(look);
    this.shown = shown;
    this.deps.log.debug('heartbeat: status set', { emoji: look.emoji, text: look.text });
  }
}
