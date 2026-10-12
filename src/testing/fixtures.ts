/** Shared test fixtures. */
import type { InboxMessage } from '../inbox/types';

/** A message from the human at Slack time `ts` (e.g. `'1.0'`), id `${conversation}:${ts}`. */
export function inboxMessage(
  ts: string,
  conversation = 'D1',
  text = `message ${ts}`,
): InboxMessage {
  return {
    id: `${conversation}:${ts}`,
    conversation,
    channel: conversation,
    channelType: 'im',
    channelName: '',
    ts,
    user: 'U0HUMAN',
    userName: '지훈',
    text,
    receivedAt: '2026-10-10T00:00:00.000Z',
  };
}
