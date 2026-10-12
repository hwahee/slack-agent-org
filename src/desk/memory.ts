/**
 * A desk with no screen — records what the hands did. For tests and for
 * running the whole loop on a machine without a display (CI).
 */
import { clampRect } from './geometry';
import { formatKeyCombo } from './keys';
import type { Desk, Rect, Screenshot, ScreenChanges, Size, TextLine } from './types';
import { linesIn } from './vision';

/** A valid 1×1 transparent PNG. */
const BLANK_PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  ),
  (char) => char.charCodeAt(0),
);

export interface MemoryDesk extends Desk {
  /**
   * Every action and every deliberate look, in order, e.g. `click 10,20 left x1`,
   * `type 안녕`, `key cmd+k`, `screenshot`, `read_screen 0,0,100,50`.
   * The automatic `changes` after an action is not listed.
   */
  readonly actions: string[];
  /** The text "on screen", for `readText`. */
  screenText: TextLine[];
  /** What `changes` reports next (then it reports no change again). */
  nextChanges: ScreenChanges | undefined;
}

const NO_CHANGE: ScreenChanges = { ratio: 0, areas: [], omitted: 0 };

const describeRect = (r: Rect) => `${r.x},${r.y},${r.width},${r.height}`;

export function createMemoryDesk(screen: Size = { width: 1440, height: 900 }): MemoryDesk {
  const actions: string[] = [];
  const record = (action: string) => {
    actions.push(action);
    return Promise.resolve();
  };
  const desk: MemoryDesk = {
    actions,
    screenText: [],
    nextChanges: undefined,
    problem: () => Promise.resolve(undefined),
    screenshot(region): Promise<Screenshot> {
      if (!region) {
        actions.push('screenshot');
        return Promise.resolve({ ...screen, png: BLANK_PNG });
      }
      const part = clampRect(region, screen);
      if (!part) return Promise.reject(new Error('region is off the screen'));
      actions.push(`screenshot ${describeRect(part)}`);
      return Promise.resolve({
        width: part.width,
        height: part.height,
        region: part,
        png: BLANK_PNG,
      });
    },
    readText(region) {
      actions.push(region ? `read_screen ${describeRect(region)}` : 'read_screen');
      return Promise.resolve(region ? linesIn(desk.screenText, region) : [...desk.screenText]);
    },
    changes() {
      const changes = desk.nextChanges ?? NO_CHANGE;
      desk.nextChanges = undefined;
      return Promise.resolve(changes);
    },
    click: (at, { button = 'left', count = 1 } = {}) =>
      record(`click ${at.x},${at.y} ${button} x${count}`),
    move: (to) => record(`move ${to.x},${to.y}`),
    scroll: (at, lines) => record(`scroll ${at.x},${at.y} ${lines}`),
    type: (text) => record(`type ${text}`),
    key: (combo) => record(`key ${formatKeyCombo(combo)}`),
  };
  return desk;
}
