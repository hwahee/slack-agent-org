/**
 * Desk tools — eyes, mouse, keyboard. The only way anything leaves this agent.
 *
 * Three ways to look, cheapest first: every action reports what changed on
 * screen (and the text there), `read_screen` reads the text on screen, and
 * `screenshot` shows the picture. All of it comes from the pixels on screen.
 */
import { parseKeyCombo } from '../desk/keys';
import type { Desk } from '../desk/types';
import { s, toDescribedValidator } from '../validation';
import { describeChanges, describeLines } from './describe';
import { defineTool, failure, text, type ToolResult } from './types';

const point = { x: s.int().check(s.gte(0)), y: s.int().check(s.gte(0)) };
const region = s.optional(
  s.object({
    ...point,
    width: s.int().check(s.gte(1)),
    height: s.int().check(s.gte(1)),
  }),
);

/** Text read in one go, so a full screen of text does not cost more than its picture. */
const READ_CHARS = 3000;

/** Says what was done, then what changed on screen because of it. */
async function done(desk: Desk, what: string): Promise<ToolResult> {
  let seen: string;
  try {
    seen = describeChanges(await desk.changes());
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    seen = `화면 변화: 확인하지 못했습니다 (${reason}). 필요하면 screenshot으로 보세요.`;
  }
  return { content: [text(`${what}\n${seen}`)] };
}

const screenshot = defineTool({
  name: 'screenshot',
  description:
    '화면을 그림으로 봅니다. 비싼 눈입니다: 처음 보는 화면이거나, 화면 변화와 read_screen의 글자만으로는 ' +
    '알 수 없을 때(아이콘, 그림, 배치)만 쓰세요. region(x, y, width, height)을 주면 그 부분만 봅니다. ' +
    '좌표는 언제나 전체 화면 그림의 픽셀 기준이며, 부분 그림의 점 (a, b)는 화면 좌표 (x + a, y + b)입니다.',
  input: toDescribedValidator(s.object({ region })),
  async run({ region: part }, { desk }) {
    const shot = await desk.screenshot(part);
    const where = shot.region
      ? `화면의 (${shot.region.x}, ${shot.region.y})–(${shot.region.x + shot.width}, ${shot.region.y + shot.height}) 부분, ` +
        `그림 안의 점 (a, b) = 화면 좌표 (${shot.region.x} + a, ${shot.region.y} + b)`
      : `화면 ${shot.width}×${shot.height}px`;
    return {
      content: [
        { type: 'image', data: Buffer.from(shot.png).toString('base64'), mimeType: 'image/png' },
        text(where),
      ],
    };
  },
});

const readScreen = defineTool({
  name: 'read_screen',
  description:
    '화면의 글자를 읽어 줄마다 (중심 x, y)와 함께 돌려줍니다. 싼 눈입니다. ' +
    'region(x, y, width, height)을 주면 그 부분만 읽으니 가능하면 좁혀서 읽으세요. ' +
    '아이콘·그림·색처럼 글자가 아닌 것은 보이지 않습니다.',
  input: toDescribedValidator(s.object({ region })),
  async run({ region: part }, { desk }) {
    return { content: [text(describeLines(await desk.readText(part), READ_CHARS))] };
  },
});

const ACTION_NOTE = ' 결과에 그 뒤의 화면 변화(바뀐 영역과 그 안의 글자)가 붙습니다.';

const click = defineTool({
  name: 'click',
  description:
    '마우스로 (x, y)를 클릭합니다. double=true면 더블클릭, button="right"면 우클릭.' + ACTION_NOTE,
  input: toDescribedValidator(
    s.object({
      ...point,
      button: s.optional(s.enum(['left', 'right'])),
      double: s.optional(s.boolean()),
    }),
  ),
  async run({ x, y, button, double }, { desk }) {
    await desk.click({ x, y }, { button: button ?? 'left', count: double ? 2 : 1 });
    return done(desk, `클릭: (${x}, ${y})`);
  },
});

const move = defineTool({
  name: 'move',
  description: '마우스 포인터를 (x, y)로 옮깁니다 (호버 메뉴를 띄울 때 등).' + ACTION_NOTE,
  input: toDescribedValidator(s.object(point)),
  async run({ x, y }, { desk }) {
    await desk.move({ x, y });
    return done(desk, `포인터: (${x}, ${y})`);
  },
});

const scroll = defineTool({
  name: 'scroll',
  description: '(x, y) 위에서 휠을 굴립니다. lines가 양수면 아래로, 음수면 위로.' + ACTION_NOTE,
  input: toDescribedValidator(s.object({ ...point, lines: s.int().check(s.gte(-30), s.lte(30)) })),
  async run({ x, y, lines }, { desk }) {
    if (lines === 0) return failure('lines는 0이 아니어야 합니다.');
    await desk.scroll({ x, y }, lines);
    return done(desk, `스크롤: (${x}, ${y}) ${lines}줄`);
  },
});

const type = defineTool({
  name: 'type',
  description:
    '키보드로 글자를 입력합니다 (한글 가능). 줄바꿈은 넣을 수 없습니다: ' +
    'Slack 입력창에서 줄을 바꾸려면 key "shift+enter", 보내려면 key "enter"를 따로 누르세요.',
  input: toDescribedValidator(
    s.object({ text: s.string().check(s.minLength(1), s.maxLength(4000)) }),
  ),
  async run({ text: value }, { desk }) {
    if (/[\r\n]/.test(value)) {
      return failure(
        '줄바꿈이 들어 있습니다. 줄마다 따로 type 하고, 사이에 key "shift+enter"를 누르세요 ' +
          '(Enter는 메시지를 보냅니다).',
      );
    }
    await desk.type(value);
    return done(desk, `입력: ${value.length}자`);
  },
});

const key = defineTool({
  name: 'key',
  description:
    '키나 단축키를 누릅니다. 예: "enter", "escape", "cmd+k", "shift+enter", "cmd+a", "up". ' +
    '수식키: cmd, shift, alt(option), ctrl, fn.',
  input: toDescribedValidator(s.object({ combo: s.string().check(s.minLength(1)) })),
  async run({ combo }, { desk }) {
    await desk.key(parseKeyCombo(combo));
    return done(desk, `키: ${combo}`);
  },
});

const wait = defineTool({
  name: 'wait',
  description:
    '화면이 바뀌기를 잠시 기다립니다 (앱 실행, 로딩 등). 최대 10초. 기다린 동안의 화면 변화를 알려 줍니다.',
  input: toDescribedValidator(s.object({ seconds: s.number().check(s.gt(0), s.lte(10)) })),
  async run({ seconds }, { desk }) {
    await Bun.sleep(seconds * 1000);
    return done(desk, `${seconds}초 기다림`);
  },
});

export const DESK_TOOLS = [screenshot, readScreen, click, move, scroll, type, key, wait];
