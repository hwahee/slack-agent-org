import { describe, expect, test } from 'bun:test';

import { parseMessageEnvelope } from './events';
import { allowedWriteScopes, findWriteScopes } from './scopes';

function envelope(event: Record<string, unknown>) {
  return { team_id: 'T1', event_id: 'Ev1', event };
}

describe('parseMessageEnvelope', () => {
  test('reads a direct message', () => {
    expect(
      parseMessageEnvelope(
        envelope({
          type: 'message',
          channel: 'D1',
          channel_type: 'im',
          user: 'U0HUMAN',
          text: '안녕',
          ts: '1700000000.000100',
          event_ts: '1700000000.000100',
        }),
      ),
    ).toEqual({
      channel: 'D1',
      channelType: 'im',
      user: 'U0HUMAN',
      text: '안녕',
      ts: '1700000000.000100',
    });
  });

  test('keeps thread, subtype and bot markers', () => {
    expect(
      parseMessageEnvelope(
        envelope({
          type: 'message',
          channel: 'C1',
          channel_type: 'channel',
          subtype: 'bot_message',
          bot_id: 'B1',
          text: 'deploy done',
          ts: '2.0',
          thread_ts: '1.0',
        }),
      ),
    ).toEqual({
      channel: 'C1',
      channelType: 'channel',
      text: 'deploy done',
      ts: '2.0',
      threadTs: '1.0',
      subtype: 'bot_message',
      botId: 'B1',
    });
  });

  test('ignores anything that is not a message event', () => {
    expect(parseMessageEnvelope(envelope({ type: 'reaction_added', user: 'U1' }))).toBeNull();
    expect(parseMessageEnvelope({ type: 'hello' })).toBeNull();
    expect(parseMessageEnvelope(null)).toBeNull();
  });

  test('ignores messages from unknown conversation kinds', () => {
    expect(
      parseMessageEnvelope(
        envelope({ type: 'message', channel: 'X1', channel_type: 'app_home', ts: '1.0' }),
      ),
    ).toBeNull();
  });
});

describe('findWriteScopes', () => {
  test('finds every scope that can change something', () => {
    expect(
      findWriteScopes([
        'channels:history',
        'chat:write',
        'chat:write.public',
        'users:read',
        'reactions:write',
        'incoming-webhook',
      ]),
    ).toEqual(['chat:write', 'chat:write.public', 'reactions:write', 'incoming-webhook']);
  });

  test('passes a read-only set', () => {
    expect(findWriteScopes(['im:history', 'users:read', 'channels:read'])).toEqual([]);
  });

  test('lets the status scope through only while SLACK_STATUS is on', () => {
    const scopes = ['im:history', 'users.profile:write'];
    expect(findWriteScopes(scopes, allowedWriteScopes('on'))).toEqual([]);
    expect(findWriteScopes(scopes, allowedWriteScopes('off'))).toEqual(['users.profile:write']);
    // Nothing else rides on the exception.
    expect(
      findWriteScopes(['users.profile:write', 'chat:write'], allowedWriteScopes('on')),
    ).toEqual(['chat:write']);
  });
});
