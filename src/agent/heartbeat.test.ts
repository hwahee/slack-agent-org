import { describe, expect, test } from 'bun:test';

import { silentLogger } from '../lib/log';
import type { StatusLook } from '../slack/types';
import { Heartbeat } from './heartbeat';
import { stamp } from './status';

// 15:30 in Seoul.
const AT = new Date('2026-10-22T06:30:00.000Z');

function setup(problems: { desk?: string; other?: string } = {}) {
  const shown: StatusLook[] = [];
  const health = { ...problems };
  const heartbeat = new Heartbeat({
    status: {
      set: (look) => {
        shown.push(look);
        return Promise.resolve();
      },
    },
    deskProblem: () => Promise.resolve(health.desk),
    otherProblem: () => health.other,
    template: '근무 중 · {time} 확인',
    timeZone: 'Asia/Seoul',
    log: silentLogger,
  });
  return { heartbeat, shown, health };
}

describe('stamp', () => {
  test('fills in the local time and date', () => {
    expect(stamp('근무 중 · {time} 확인', AT, 'Asia/Seoul')).toBe('근무 중 · 15:30 확인');
    expect(stamp('{date} {time}', AT, 'Asia/Seoul')).toBe('10/22 15:30');
    expect(stamp('{time}', new Date('2026-10-22T15:05:00.000Z'), 'Asia/Seoul')).toBe('00:05');
  });
});

describe('Heartbeat', () => {
  test('stamps the working status with the time it found the agent fine', async () => {
    const { heartbeat, shown } = setup();
    await heartbeat.beat(AT);
    await heartbeat.beat(new Date('2026-10-22T06:40:00.000Z'));
    expect(shown).toEqual([
      { emoji: ':large_green_circle:', text: '근무 중 · 15:30 확인' },
      { emoji: ':large_green_circle:', text: '근무 중 · 15:40 확인' },
    ]);
  });

  test('shows "permission needed" once while the desk waits for a person', async () => {
    const { heartbeat, shown, health } = setup({ desk: 'screen recording not allowed' });
    await heartbeat.beat(AT);
    await heartbeat.beat(AT);
    expect(shown.map((look) => look.emoji)).toEqual([':warning:']);

    health.desk = undefined;
    await heartbeat.beat(AT);
    expect(shown.at(-1)?.text).toBe('근무 중 · 15:30 확인');
  });

  test('leaves the status alone when anything else is wrong, so its time stops', async () => {
    const { heartbeat, shown, health } = setup();
    await heartbeat.beat(AT);
    health.other = 'slack connection down';
    await heartbeat.beat(new Date('2026-10-22T06:40:00.000Z'));
    expect(shown).toHaveLength(1);
  });

  test('a failing status call is only logged', async () => {
    const warnings: string[] = [];
    const heartbeat = new Heartbeat({
      status: { set: () => Promise.reject(new Error('ratelimited')) },
      deskProblem: () => Promise.resolve(undefined),
      otherProblem: () => undefined,
      template: '{time}',
      timeZone: 'Asia/Seoul',
      log: { ...silentLogger, warn: (message) => warnings.push(message) },
    });
    await heartbeat.beat(AT);
    expect(warnings).toEqual(['heartbeat failed']);
  });
});
