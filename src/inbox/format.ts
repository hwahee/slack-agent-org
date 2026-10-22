/**
 * How a waiting message reads to the agent — the text of a notification.
 * Shared by the turn prompt and the inbox tools so both say the same thing.
 */
import type { InboxMessage } from './types';

/** A moment as a local wall-clock time, like Slack shows ("10. 10. 오전 9:00"). */
export function wallClock(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone,
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

/** Slack `ts` ("1700000000.000100") → a local wall-clock time. */
export function slackTime(ts: string, timeZone: string): string {
  const date = new Date(Number(ts.split('.')[0]) * 1000);
  return Number.isNaN(date.getTime()) ? ts : wallClock(date, timeZone);
}

function where(message: InboxMessage): string {
  switch (message.channelType) {
    case 'im':
      return 'DM';
    case 'mpim':
      return `그룹 DM(${message.channelName})`;
    default:
      return `#${message.channelName}`;
  }
}

export interface FormatOptions {
  readonly timeZone: string;
  /** Cut the text after this many characters (a preview). */
  readonly maxText?: number;
}

export function formatMessage(message: InboxMessage, options: FormatOptions): string {
  const thread = message.threadTs && message.threadTs !== message.ts ? ' · 스레드 답글' : '';
  const text =
    options.maxText !== undefined && message.text.length > options.maxText
      ? `${message.text.slice(0, options.maxText)}…`
      : message.text;
  const late = message.missed ? ' · 늦게 확인' : '';
  const header = `[${message.id}] ${where(message)}${thread} · ${message.userName} · ${slackTime(message.ts, options.timeZone)}${late}`;
  const body = text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
  const notes = [
    ...(message.missed
      ? [
          '  ↳ 꺼져 있었거나 연결이 끊긴 동안 온 글이라 지금 처음 봅니다. 시간이 지났으니 아직 답이 필요한지 화면에서 확인하고, 답한다면 늦은 것을 짧게 알리세요.',
        ]
      : []),
    ...(message.triage
      ? [
          `  ↳ 답할 만하다고 판단한 이유: ${message.triage.reason}`,
          '  ↳ 답하기 전에 화면에서 최신 대화를 확인하세요. 그사이 다른 사람이 답했거나 끝난 이야기면 답하지 않고 넘어갑니다.',
        ]
      : []),
  ];
  const tag = message.triage ? ' · 나를 부르지 않은 채널 글' : '';
  return [`${header}${tag}`, body, ...notes].join('\n');
}
