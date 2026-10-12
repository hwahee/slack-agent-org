/**
 * The agent's hands — the same desk a person sits at.
 *
 * Screen in, mouse and keyboard out; nothing else. The agent finds the reply
 * box on the screen and clicks it like anyone would. Every coordinate is in
 * the pixel space of the full-screen screenshot this desk returns, whatever the
 * display's real resolution; the driver does the conversion.
 *
 * Looking comes in three costs, all from the pixels on screen and nothing a
 * person could not see: what changed since the last look (cheap, after every
 * action), the text on screen (cheap), and the picture itself (expensive).
 */
import type { KeyCombo } from './keys';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** A box on the screen; `x`, `y` is its top-left corner. */
export interface Rect extends Point, Size {}

export interface Screenshot extends Size {
  readonly png: Uint8Array;
  /** Set when only part of the screen was taken: where that part is. */
  readonly region?: Rect;
}

/** One line of text read off the screen. */
export interface TextLine {
  readonly text: string;
  readonly box: Rect;
}

/** One changed area, with the text that is in it now. */
interface ScreenChange {
  readonly box: Rect;
  readonly lines: readonly TextLine[];
}

/** What changed on screen since the desk last looked at all of it. */
export interface ScreenChanges {
  /** Share of the screen that changed, 0–1. */
  readonly ratio: number;
  /** The largest changed areas, largest first. Text is read only when the change is not a new screen. */
  readonly areas: readonly ScreenChange[];
  /** Small changes left out (a blinking caret, a spinner). */
  readonly omitted: number;
}

type MouseButton = 'left' | 'right';

export interface Desk {
  /**
   * What keeps this desk from working right now (a missing OS permission …),
   * or undefined when it is ready. The runtime holds turns until it is ready,
   * so messages wait in the queue instead of reaching an agent that cannot see.
   */
  problem(): Promise<string | undefined>;
  /** The picture of the screen, or of `region` only. A full picture is also the next reference for `changes`. */
  screenshot(region?: Rect): Promise<Screenshot>;
  /** Text on the screen (inside `region`), top to bottom. Also the next reference for `changes`. */
  readText(region?: Rect): Promise<TextLine[]>;
  /**
   * What changed since the last full look (screenshot, readText or changes),
   * then that becomes the reference. Undefined when there is nothing to compare with yet.
   */
  changes(): Promise<ScreenChanges | undefined>;
  click(at: Point, options?: { button?: MouseButton; count?: 1 | 2 }): Promise<void>;
  move(to: Point): Promise<void>;
  /** Wheel lines; positive scrolls down. */
  scroll(at: Point, lines: number): Promise<void>;
  /** Types text as-is. Never presses Enter — line breaks are keys (see the tool). */
  type(text: string): Promise<void>;
  key(combo: KeyCombo): Promise<void>;
}

/** The desk could not act (missing helper, missing OS permission, …). */
export class DeskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeskError';
  }
}
