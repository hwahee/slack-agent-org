/**
 * How the cheap eyes read to the agent: what changed after an action, and the
 * text on screen. Coordinates are the ones the agent clicks with.
 */
import type { ScreenChanges, TextLine } from '../desk/types';
import { NEW_SCREEN_RATIO, centerOf } from '../desk/vision';

/** Text per changed area, so a report stays a few lines long. */
const AREA_TEXT_CHARS = 200;

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function share(ratio: number): string {
  const percent = Math.round(ratio * 100);
  return percent < 1 ? '1% 미만' : `${percent}%`;
}

export function describeChanges(changes: ScreenChanges | undefined): string {
  if (!changes) {
    return '화면 변화: 비교할 이전 화면이 없습니다. 필요하면 read_screen이나 screenshot으로 보세요.';
  }
  const { ratio, areas, omitted } = changes;
  if (areas.length === 0) {
    return omitted > 0 ? `화면 변화: 거의 없음 (작은 변화 ${omitted}곳)` : '화면 변화: 없음';
  }
  if (ratio >= NEW_SCREEN_RATIO) {
    return `화면 변화: 화면의 ${share(ratio)}가 바뀌었습니다(새 화면). read_screen이나 screenshot으로 확인하세요.`;
  }
  const lines = areas.map(({ box, lines: found }) => {
    const where = `(${box.x}, ${box.y})–(${box.x + box.width}, ${box.y + box.height})`;
    const said =
      found.length > 0
        ? clip(found.map((line) => `"${line.text}"`).join(' '), AREA_TEXT_CHARS)
        : '글자 없음 (아이콘·색·그림이 바뀜)';
    return `- ${where}: ${said}`;
  });
  return [
    `화면 변화 ${areas.length}곳 (화면의 ${share(ratio)}):`,
    ...lines,
    ...(omitted > 0 ? [`- 작은 변화 ${omitted}곳 생략`] : []),
  ].join('\n');
}

/** One line per text line: its center (where to click it), then the text. */
export function describeLines(lines: readonly TextLine[], maxChars: number): string {
  if (lines.length === 0) return '읽을 수 있는 글자가 없습니다.';
  const rows: string[] = [];
  let used = 0;
  for (const line of lines) {
    const { x, y } = centerOf(line.box);
    const row = `(${x}, ${y}) ${line.text}`;
    if (used + row.length > maxChars) {
      rows.push(`… ${lines.length - rows.length}줄 더 있음 — 영역을 좁혀 다시 읽으세요.`);
      break;
    }
    rows.push(row);
    used += row.length + 1;
  }
  return rows.join('\n');
}
