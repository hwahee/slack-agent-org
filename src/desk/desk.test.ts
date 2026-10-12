import { describe, expect, test } from 'bun:test';

import { clampRect, fitWithin, toScreenPoint, toScreenRect } from './geometry';
import { formatKeyCombo, KeyComboError, parseKeyCombo } from './keys';
import { linesIn, padRect, pickAreas, unionRect } from './vision';

describe('parseKeyCombo', () => {
  test('normalizes aliases and modifier order', () => {
    expect(formatKeyCombo(parseKeyCombo('Shift+Command+K'))).toBe('shift+cmd+k');
    expect(formatKeyCombo(parseKeyCombo('cmd+shift+k'))).toBe('shift+cmd+k');
    expect(formatKeyCombo(parseKeyCombo('shift+enter'))).toBe('shift+return');
    expect(formatKeyCombo(parseKeyCombo('option+backspace'))).toBe('alt+delete');
    expect(formatKeyCombo(parseKeyCombo('esc'))).toBe('escape');
    expect(formatKeyCombo(parseKeyCombo('f12'))).toBe('f12');
    expect(formatKeyCombo(parseKeyCombo('cmd+/'))).toBe('cmd+/');
  });

  test('rejects what the helper could not press', () => {
    expect(() => parseKeyCombo('hyper+k')).toThrow(KeyComboError);
    expect(() => parseKeyCombo('cmd+ㅋ')).toThrow(KeyComboError);
    expect(() => parseKeyCombo('cmd+')).toThrow(KeyComboError);
    expect(() => parseKeyCombo('')).toThrow(KeyComboError);
  });
});

describe('geometry', () => {
  test('a MacBook Air screen fits as is', () => {
    expect(fitWithin({ width: 1440, height: 900 }, 1440)).toEqual({ width: 1440, height: 900 });
  });

  test('a larger screen is scaled down, never up', () => {
    expect(fitWithin({ width: 2560, height: 1440 }, 1280)).toEqual({ width: 1280, height: 720 });
    expect(fitWithin({ width: 800, height: 600 }, 1440)).toEqual({ width: 800, height: 600 });
  });

  test('maps image pixels back to screen points', () => {
    const image = { width: 1280, height: 720 };
    const screen = { width: 2560, height: 1440 };
    expect(toScreenPoint({ x: 640, y: 360 }, image, screen)).toEqual({ x: 1280, y: 720 });
  });

  test('keeps the pointer on the screen', () => {
    const size = { width: 1440, height: 900 };
    expect(toScreenPoint({ x: -5, y: 5000 }, size, size)).toEqual({ x: 0, y: 899 });
  });
});

describe('regions', () => {
  const screen = { width: 1080, height: 698 };

  test('a region is cut to the screen, or refused when it is off it', () => {
    expect(clampRect({ x: 1000, y: -10, width: 200, height: 50 }, screen)).toEqual({
      x: 1000,
      y: 0,
      width: 80,
      height: 40,
    });
    expect(clampRect({ x: 2000, y: 0, width: 10, height: 10 }, screen)).toBeUndefined();
  });

  test('maps a region of the image to screen points', () => {
    const image = { width: 1080, height: 675 };
    const display = { width: 1728, height: 1080 };
    expect(toScreenRect({ x: 100, y: 50, width: 300, height: 200 }, image, display)).toEqual({
      x: 160,
      y: 80,
      width: 480,
      height: 320,
    });
  });
});

describe('changed areas', () => {
  const area = (x: number, y: number, width: number, height: number, cells: number) => ({
    x,
    y,
    width,
    height,
    cells,
  });

  test('keeps the largest areas and drops the noise', () => {
    const { areas, omitted } = pickAreas([
      area(500, 300, 12, 24, 2), // a blinking caret
      area(100, 600, 400, 36, 30),
      area(0, 0, 1080, 120, 200),
    ]);
    expect(areas).toEqual([
      { x: 0, y: 0, width: 1080, height: 120 },
      { x: 100, y: 600, width: 400, height: 36 },
    ]);
    expect(omitted).toBe(1);
  });

  test('describes at most four areas', () => {
    const many = [0, 1, 2, 3, 4, 5].map((i) => area(i * 100, 0, 50, 50, 10));
    const { areas, omitted } = pickAreas(many);
    expect(areas).toHaveLength(4);
    expect(omitted).toBe(2);
  });

  test('reads the text once around all areas, then gives each area its lines', () => {
    const screen = { width: 1080, height: 698 };
    const around = unionRect([
      { x: 100, y: 600, width: 400, height: 36 },
      { x: 20, y: 40, width: 100, height: 20 },
    ]);
    expect(around).toEqual({ x: 20, y: 40, width: 480, height: 596 });
    expect(padRect({ x: 5, y: 690, width: 100, height: 8 }, 12, screen)).toEqual({
      x: 0,
      y: 678,
      width: 117,
      height: 20,
    });

    const lines = [
      { text: '두 번째', box: { x: 300, y: 610, width: 80, height: 16 } },
      { text: '첫 번째', box: { x: 110, y: 612, width: 80, height: 16 } },
      { text: '다른 곳', box: { x: 30, y: 42, width: 60, height: 16 } },
    ];
    expect(linesIn(lines, { x: 100, y: 600, width: 400, height: 36 }).map((l) => l.text)).toEqual([
      '첫 번째',
      '두 번째',
    ]);
  });
});
