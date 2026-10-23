/**
 * The agent's Slack status — what the team sees next to its name.
 *
 * Set through the Slack API (src/slack/status.ts) — the one exception to
 * "sending is GUI only", by decision: nobody watches a status change, and on
 * screen it took a whole turn. Set when the agent starts working, when its
 * desk is waiting for a person, and on a graceful shutdown. Not per turn: a
 * status that flips with every message tells the team little.
 *
 * While working, the heartbeat (./heartbeat.ts) stamps the status with the
 * time it last found the agent fine ("근무 중 · 15:30 확인", HEARTBEAT_TEXT).
 * A forced exit, a crash or a power cut leaves whatever was set last — and
 * a time that stopped moving says so.
 */

import type { StatusLook } from '../slack/types';

export type AgentStatus = 'working' | 'blocked' | 'restarting' | 'off' | 'offWithWork';

/** Every status the agent can show, in one place. All are set with "don't clear". */
export const STATUS_LOOKS: Readonly<Record<AgentStatus, StatusLook>> = {
  /** Started and at the desk — messages get answered. Shown stamped (`heartbeatLook`). */
  working: { emoji: ':large_green_circle:', text: '근무 중' },
  /** Running, but the desk lacks a macOS permission — a person has to grant it. */
  blocked: { emoji: ':warning:', text: '화면 권한 필요 · 사람의 확인을 기다리는 중' },
  /** Stopping to start again (`bun run service:restart`) — back in a moment. */
  restarting: { emoji: ':arrows_counterclockwise:', text: '재시작 중 · 곧 돌아옵니다' },
  /** Stopped with nothing left over. */
  off: { emoji: ':zzz:', text: '꺼져 있음' },
  /** Stopped while messages or a paused task were still waiting — handled on the next start. */
  offWithWork: { emoji: ':inbox_tray:', text: '꺼져 있음 · 남은 일은 다음에 켜지면 처리' },
};

interface ShutdownSituation {
  /** A restart was asked for (the marker written by `service:restart`). */
  readonly restarting: boolean;
  /** Messages not yet answered plus paused tasks. */
  readonly leftOver: number;
}

/** Which status a graceful shutdown leaves behind. A restart wins: the agent is back soon. */
export function shutdownStatus({ restarting, leftOver }: ShutdownSituation): AgentStatus {
  if (restarting) return 'restarting';
  return leftOver > 0 ? 'offWithWork' : 'off';
}

export function statusLook(status: AgentStatus, leftOver = 0): StatusLook {
  const look = STATUS_LOOKS[status];
  if (status !== 'offWithWork' || leftOver === 0) return look;
  return { ...look, text: `꺼져 있음 · 남은 일 ${leftOver}건은 다음에 켜지면 처리` };
}

/** `template` with `{time}` → 15:30 and `{date}` → 10/22, as of `at` in `timeZone`. */
export function stamp(template: string, at: Date, timeZone: string): string {
  const part = (options: Intl.DateTimeFormatOptions) =>
    Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', ...options })
        .formatToParts(at)
        .map(({ type, value }) => [type, value]),
    );
  const { hour, minute } = part({ hour: '2-digit', minute: '2-digit' });
  const { month, day } = part({ month: 'numeric', day: 'numeric' });
  return template.replaceAll('{time}', `${hour}:${minute}`).replaceAll('{date}', `${month}/${day}`);
}

/** The working status, stamped with the moment the agent was last found fine. */
export function heartbeatLook(template: string, at: Date, timeZone: string): StatusLook {
  return { emoji: STATUS_LOOKS.working.emoji, text: stamp(template, at, timeZone) };
}
