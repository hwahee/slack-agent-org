import { describe, expect, test } from 'bun:test';

import { loadConfig } from './config';

const minimal = {
  AGENT_NAME: '클로이',
  AGENT_SLACK_USER_ID: 'U0AGENT',
  HUMAN_SLACK_USER_IDS: 'U0HUMAN',
  SLACK_APP_TOKEN: 'xapp-1-abc',
  SLACK_READ_TOKEN: 'xoxp-123',
};

describe('loadConfig', () => {
  test('fills defaults around the required values', () => {
    const config = loadConfig(minimal);
    expect(config).toMatchObject({
      agentName: '클로이',
      humanSlackUserIds: ['U0HUMAN'],
      slackClient: 'desktop',
      engineDriver: 'claude-cli',
      claudeBin: 'claude',
      maxAgentExchanges: 4,
      toolsPort: 0,
      dataDir: 'data',
    });
    expect(config.claudeModel).toBeUndefined();
  });

  test('rejects an unknown time zone', () => {
    expect(loadConfig(minimal).timeZone).toBe('Asia/Seoul');
    expect(() => loadConfig({ ...minimal, TIME_ZONE: 'Mars/Olympus' })).toThrow();
  });

  test('treats empty optional values as unset', () => {
    const config = loadConfig({ ...minimal, CLAUDE_MODEL: '', SLACK_CLIENT: '' });
    expect(config.claudeModel).toBeUndefined();
    expect(config.slackClient).toBe('desktop');
  });

  test('splits and trims the human list', () => {
    expect(
      loadConfig({ ...minimal, HUMAN_SLACK_USER_IDS: ' U0A , U0B ,' }).humanSlackUserIds,
    ).toEqual(['U0A', 'U0B']);
  });

  test('requires at least one human (the loop guard needs someone to reset it)', () => {
    expect(() => loadConfig({ ...minimal, HUMAN_SLACK_USER_IDS: '' })).toThrow();
  });

  test('rejects tokens of the wrong kind', () => {
    expect(() => loadConfig({ ...minimal, SLACK_APP_TOKEN: 'xoxb-1' })).toThrow();
    expect(() => loadConfig({ ...minimal, SLACK_READ_TOKEN: 'xapp-1' })).toThrow();
  });

  test('refuses the agent listed as a human', () => {
    expect(() => loadConfig({ ...minimal, HUMAN_SLACK_USER_IDS: 'U0HUMAN,U0AGENT' })).toThrow(
      'must not be listed',
    );
  });
});
