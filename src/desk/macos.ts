/**
 * macOS desk driver.
 *
 *   - Eyes: `screencapture` and `sips` (scales the picture down to what the
 *     model is shown) — both ship with macOS. The helper compares frames and
 *     reads text off them (ImageIO, Vision), so most looks need no picture.
 *   - Hands: native/desk-helper.swift, compiled once with `bun run desk:build`.
 *     It posts real mouse and keyboard events (CGEvent), exactly what a
 *     person's trackpad and keyboard produce.
 *
 * Needs, for the process that runs it: Screen Recording (eyes) and
 * Accessibility (hands). See docs/mac-setup.md.
 */
import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';

import { s, toValidator } from '../validation';
import { clampRect, fitWithin, toScreenPoint, toScreenRect } from './geometry';
import { formatKeyCombo } from './keys';
import { DeskError, type Desk, type Point, type Rect, type Size, type TextLine } from './types';
import { NEW_SCREEN_RATIO, linesIn, padRect, pickAreas, readingOrder, unionRect } from './vision';

const sizeValidator = toValidator(s.object({ width: s.number(), height: s.number() }));
const permissionsValidator = toValidator(
  s.object({ accessibility: s.boolean(), screenRecording: s.boolean() }),
);
const box = { x: s.number(), y: s.number(), width: s.number(), height: s.number() };
const diffValidator = toValidator(
  s.object({ ratio: s.number(), areas: s.array(s.object({ ...box, cells: s.number() })) }),
);
const linesValidator = toValidator(s.array(s.object({ text: s.string(), ...box })));

/** Frames are compared in blocks of this many pixels (of the shown image). */
const CELL = 12;
/** A moment for the screen to answer an action before it is compared. */
const SETTLE_MS = 250;

export interface DeskPermissions {
  readonly accessibility: boolean;
  readonly screenRecording: boolean;
}

/** The desk, plus the checks `doctor` and `desk:probe` run. */
export interface MacDesk extends Desk {
  /** The main display in points. */
  display(): Promise<Size>;
  permissions(): Promise<DeskPermissions>;
  /**
   * Like `permissions`, but asks macOS to show its prompts for what is missing.
   * The prompt also adds the responsible app to the lists in System Settings.
   */
  requestPermissions(): Promise<DeskPermissions>;
}

export interface MacDeskOptions {
  readonly helperPath: string;
  readonly maxEdge: number;
  /** Where the screen images are written (overwritten every time). */
  readonly workDir: string;
}

async function run(command: string[], stdin?: string): Promise<string> {
  let proc;
  try {
    proc = Bun.spawn(command, {
      stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (error) {
    throw new DeskError(`cannot run ${command[0]}: ${String(error)}`);
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new DeskError(`${command.slice(0, 2).join(' ')} failed (${code}): ${stderr.trim()}`);
  }
  return stdout;
}

export function createMacDesk({ helperPath, maxEdge, workDir }: MacDeskOptions): MacDesk {
  const helper = (args: string[], stdin?: string) => run([helperPath, ...args], stdin);

  async function display(): Promise<Size> {
    return sizeValidator.parse(JSON.parse(await helper(['display'])));
  }

  /** Image pixels → screen points, for the display as it is right now. */
  async function toScreen(point: Point): Promise<Point> {
    const screen = await display();
    return toScreenPoint(point, fitWithin(screen, maxEdge), screen);
  }

  const coords = (p: Point) => [String(p.x), String(p.y)];

  // The last full look, kept at the display's own resolution: `changes`
  // compares against it, and text is read from it at full sharpness.
  const reference = join(workDir, 'reference.png');
  const latest = join(workDir, 'latest.png');
  const picture = join(workDir, 'screen.png');

  /** The main display as it is; -x: no shutter sound. The pointer is left out so it never counts as a change. */
  async function capture(file: string): Promise<Size> {
    const [shown] = await Promise.all([
      display().then((screen) => fitWithin(screen, maxEdge)),
      mkdir(workDir, { recursive: true }),
    ]);
    await run(['screencapture', '-x', '-m', '-t', 'png', file]);
    return shown;
  }

  async function readLines(file: string, shown: Size, region?: Rect): Promise<TextLine[]> {
    const area = region ? [region.x, region.y, region.width, region.height].map(String) : [];
    const found = linesValidator.parse(
      JSON.parse(await helper(['ocr', file, String(shown.width), String(shown.height), ...area])),
    );
    return readingOrder(found.map(({ text, ...rect }) => ({ text, box: rect })));
  }

  function inside(region: Rect, shown: Size): Rect {
    const clamped = clampRect(region, shown);
    if (!clamped) {
      throw new DeskError(`region is off the screen (${shown.width}×${shown.height})`);
    }
    return clamped;
  }

  return {
    display,

    async permissions() {
      return permissionsValidator.parse(JSON.parse(await helper(['check'])));
    },

    async requestPermissions() {
      return permissionsValidator.parse(JSON.parse(await helper(['request'])));
    },

    async problem() {
      let granted = permissionsValidator.parse(JSON.parse(await helper(['check'])));
      if (granted.accessibility && granted.screenRecording) return undefined;
      // Puts macOS's own prompt on screen for a person to answer.
      granted = permissionsValidator.parse(JSON.parse(await helper(['request'])));
      const missing = [
        ...(granted.accessibility ? [] : ['Accessibility (손쉬운 사용)']),
        ...(granted.screenRecording ? [] : ['Screen Recording (화면 녹음)']),
      ];
      if (missing.length === 0) return undefined;
      return `missing ${missing.join(' + ')} for the process running ${process.execPath}`;
    },

    async screenshot(region) {
      if (region) {
        const screen = await display();
        const shown = fitWithin(screen, maxEdge);
        const part = inside(region, shown);
        const onScreen = toScreenRect(part, shown, screen);
        await mkdir(workDir, { recursive: true });
        const rect = [onScreen.x, onScreen.y, onScreen.width, onScreen.height].join(',');
        await run(['screencapture', '-x', `-R${rect}`, '-t', 'png', picture]);
        await run(['sips', '-z', String(part.height), String(part.width), picture]);
        return {
          width: part.width,
          height: part.height,
          region: part,
          png: await Bun.file(picture).bytes(),
        };
      }
      const shown = await capture(reference);
      await run([
        'sips',
        '-z',
        String(shown.height),
        String(shown.width),
        reference,
        '--out',
        picture,
      ]);
      return { ...shown, png: await Bun.file(picture).bytes() };
    },

    async readText(region) {
      const shown = await capture(reference);
      return readLines(reference, shown, region && inside(region, shown));
    },

    async changes() {
      await Bun.sleep(SETTLE_MS);
      const compare = await Bun.file(reference).exists();
      const shown = await capture(compare ? latest : reference);
      if (!compare) return undefined;

      const found = diffValidator.parse(
        JSON.parse(
          await helper([
            'diff',
            reference,
            latest,
            String(shown.width),
            String(shown.height),
            String(CELL),
          ]),
        ),
      );
      const { areas, omitted } = pickAreas(found.areas);
      const around = unionRect(areas);
      const lines =
        around && found.ratio < NEW_SCREEN_RATIO
          ? await readLines(latest, shown, padRect(around, CELL, shown))
          : [];
      await rename(latest, reference);
      return {
        ratio: found.ratio,
        areas: areas.map((area) => ({
          box: area,
          lines: linesIn(lines, padRect(area, CELL, shown)),
        })),
        omitted,
      };
    },

    async click(at, { button = 'left', count = 1 } = {}) {
      await helper(['click', ...coords(await toScreen(at)), button, String(count)]);
    },

    async move(to) {
      await helper(['move', ...coords(await toScreen(to))]);
    },

    async scroll(at, lines) {
      await helper(['scroll', ...coords(await toScreen(at)), String(Math.round(lines))]);
    },

    async type(text) {
      await helper(['type'], text);
    },

    async key(combo) {
      await helper(['key', formatKeyCombo(combo)]);
    },
  };
}
