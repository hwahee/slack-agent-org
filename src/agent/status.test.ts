import { describe, expect, test } from 'bun:test';

import { shutdownStatus, STATUS_LOOKS, statusLook } from './status';

describe('Slack status', () => {
  test('a graceful shutdown picks restart, then leftover work, then plain off', () => {
    expect(shutdownStatus({ restarting: true, leftOver: 3 })).toBe('restarting');
    expect(shutdownStatus({ restarting: false, leftOver: 2 })).toBe('offWithWork');
    expect(shutdownStatus({ restarting: false, leftOver: 0 })).toBe('off');
  });

  test('leftover work is counted in the text', () => {
    expect(statusLook('offWithWork', 2).text).toContain('남은 일 2건');
    expect(statusLook('offWithWork')).toEqual(STATUS_LOOKS.offWithWork);
    expect(statusLook('off', 2)).toEqual(STATUS_LOOKS.off);
  });

  test('every status is an emoji code with text Slack accepts (100 characters)', () => {
    for (const look of Object.values(STATUS_LOOKS)) {
      expect(look.emoji).toMatch(/^:[a-z0-9_+-]+:$/);
      expect(look.text.length).toBeLessThanOrEqual(100);
    }
  });
});
