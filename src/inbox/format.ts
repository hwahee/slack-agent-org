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
  const header = `[${message.id}] ${where(message)}${thread} · ${message.userName} · ${slackTime(message.ts, options.timeZone)}`;
  return `${header}\n${text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')}`;
}
