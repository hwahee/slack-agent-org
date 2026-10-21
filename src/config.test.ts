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
    expect(config.agentRole).toBeUndefined();
    expect(config).toMatchObject({
      channelTriage: 'on',
      triageModel: 'haiku',
      triageWaitSeconds: 30,
    });
  });

  test('channel triage can be turned off, and its model left to the CLI', () => {
    const config = loadConfig({ ...minimal, CHANNEL_TRIAGE: 'off', TRIAGE_MODEL: '' });
    expect(config.channelTriage).toBe('off');
    expect(config.triageModel).toBe('');
    expect(() => loadConfig({ ...minimal, CHANNEL_TRIAGE: 'maybe' })).toThrow();
  });

  test('the Slack status is kept by default and can be turned off', () => {
    expect(loadConfig(minimal).slackStatus).toBe('on');
    expect(loadConfig({ ...minimal, SLACK_STATUS: 'off' }).slackStatus).toBe('off');
    expect(() => loadConfig({ ...minimal, SLACK_STATUS: 'maybe' })).toThrow();
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
