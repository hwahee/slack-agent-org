/**
 * The cheap eyes, in pure functions: which changed areas are worth telling
 * the agent about, and which lines of text belong to which area. The pixels
 * are compared and read by the helper (native/desk-helper.swift); the choices
 * are made here, where tests can pin them.
 */
import type { Point, Rect, Size, TextLine } from './types';

/** A changed area as the helper reports it: a box and how many blocks changed in it. */
interface ChangedArea extends Rect {
  readonly cells: number;
}

/** Above this share of the screen, a change is a new screen rather than an edit to the old one. */
export const NEW_SCREEN_RATIO = 0.4;

/** Areas smaller than this many blocks are noise: a blinking caret, a spinner. */
const MIN_CELLS = 3;

/** At most this many areas are described. */
const MAX_AREAS = 4;

/** The areas worth describing, largest first, and how many were left out. */
export function pickAreas(found: readonly ChangedArea[]): { areas: Rect[]; omitted: number } {
  const worth = found
    .filter((area) => area.cells >= MIN_CELLS)
    .sort((a, b) => b.width * b.height - a.width * a.height)
    .slice(0, MAX_AREAS)
    .map(({ x, y, width, height }) => ({ x, y, width, height }));
  return { areas: worth, omitted: found.length - worth.length };
}

/** The smallest box around all of `rects`. */
export function unionRect(rects: readonly Rect[]): Rect | undefined {
  if (rects.length === 0) return undefined;
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** `rect` grown by `by` on every side, kept inside `bounds`. */
export function padRect(rect: Rect, by: number, bounds: Size): Rect {
  const x = Math.max(0, rect.x - by);
  const y = Math.max(0, rect.y - by);
  return {
    x,
    y,
    width: Math.min(bounds.width, rect.x + rect.width + by) - x,
    height: Math.min(bounds.height, rect.y + rect.height + by) - y,
  };
}

export function centerOf(rect: Rect): Point {
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
}

function contains(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/** Lines whose center lies in `rect`, in reading order. */
export function linesIn(lines: readonly TextLine[], rect: Rect): TextLine[] {
  return readingOrder(lines.filter((line) => contains(rect, centerOf(line.box))));
}

/** Top to bottom; lines on the same row (centers within half a line's height) left to right. */
export function readingOrder(lines: readonly TextLine[]): TextLine[] {
  const byTop = [...lines].sort((a, b) => centerOf(a.box).y - centerOf(b.box).y);
  const rows: TextLine[][] = [];
  for (const line of byTop) {
    const row = rows.at(-1);
    const first = row?.[0];
    const sameRow =
      first !== undefined &&
      centerOf(line.box).y - centerOf(first.box).y <
        Math.min(first.box.height, line.box.height) / 2;
    if (row && sameRow) row.push(line);
    else rows.push([line]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.box.x - b.box.x));
}
