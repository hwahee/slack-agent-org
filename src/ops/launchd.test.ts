import { describe, expect, test } from 'bun:test';

import { renderPlist, SERVICE_LABEL } from './launchd';

describe('renderPlist', () => {
  const plist = renderPlist({
    bunPath: '/Users/agent/.bun/bin/bun',
    repoDir: '/Users/agent/Agent/slack-agent-org',
    logDir: '/Users/agent/Agent/slack-agent-org/data/logs',
    path: '/Users/agent/.bun/bin:/usr/bin:/bin',
    exitTimeoutSeconds: 600,
  });

  test('runs the agent from the repository with bun, always on', () => {
    expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`);
    expect(plist).toContain(
      '<string>/Users/agent/.bun/bin/bun</string>\n    <string>src/index.ts</string>',
    );
    expect(plist).toContain('<key>KeepAlive</key>\n  <true/>');
    expect(plist).toContain('<key>ExitTimeOut</key>\n  <integer>600</integer>');
    expect(plist).toContain('data/logs/agent.log');
  });

  test('escapes paths', () => {
    expect(
      renderPlist({
        bunPath: '/a&b/<bun>',
        repoDir: '/r',
        logDir: '/l',
        path: '/p',
        exitTimeoutSeconds: 1,
      }),
    ).toContain('<string>/a&amp;b/&lt;bun&gt;</string>');
  });
});
