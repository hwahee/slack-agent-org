/**
 * Screenshot pixels ↔ screen points.
 *
 * The model sees a screenshot no larger than `maxEdge` on its long side (what
 * it reads best) and answers in that image's pixels. The OS moves the mouse in
 * points (a Retina display has 2 pixels per point). One function each way,
 * pure, so the mapping is pinned by tests rather than by trial clicks.
 */
import type { Point, Rect, Size } from './types';

/** The size the screen is shown at: scaled down to fit `maxEdge`, never up. */
export function fitWithin(screen: Size, maxEdge: number): Size {
  const scale = Math.min(1, maxEdge / Math.max(screen.width, screen.height));
  return {
    width: Math.round(screen.width * scale),
    height: Math.round(screen.height * scale),
  };
}

/** A point on the shown image → the same spot on screen, kept inside the screen. */
export function toScreenPoint(point: Point, image: Size, screen: Size): Point {
  const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max - 1);
  return {
    x: clamp(Math.round((point.x * screen.width) / image.width), screen.width),
    y: clamp(Math.round((point.y * screen.height) / image.height), screen.height),
  };
}

/** `rect` cut to what lies inside `bounds`; undefined when nothing does. */
export function clampRect(rect: Rect, bounds: Size): Rect | undefined {
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const right = Math.min(bounds.width, Math.round(rect.x + rect.width));
  const bottom = Math.min(bounds.height, Math.round(rect.y + rect.height));
  if (right <= x || bottom <= y) return undefined;
  return { x, y, width: right - x, height: bottom - y };
}

/** A box on the shown image → the same box on screen, in points. */
export function toScreenRect(rect: Rect, image: Size, screen: Size): Rect {
  const sx = screen.width / image.width;
  const sy = screen.height / image.height;
  return {
    x: Math.round(rect.x * sx),
    y: Math.round(rect.y * sy),
    width: Math.max(1, Math.round(rect.width * sx)),
    height: Math.max(1, Math.round(rect.height * sy)),
  };
}
