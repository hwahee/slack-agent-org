/**
 * launchd — keeps the agent running on its Mac: started at login, restarted
 * if it exits, given time to finish its turn when stopped.
 *
 * A LaunchAgent (not a LaunchDaemon) on purpose: it runs inside the logged-in
 * user's GUI session, the only place a program can see the screen and post
 * mouse and keyboard events.
 */
export const SERVICE_LABEL = 'com.slack-agent-org.agent';

export interface PlistOptions {
  readonly bunPath: string;
  readonly repoDir: string;
  readonly logDir: string;
  /** PATH for the service — launchd starts with almost none. */
  readonly path: string;
  /**
   * Seconds launchd waits after SIGTERM before SIGKILL. The agent finishes
   * its current turn before exiting (cooperative), so this is generous.
   */
  readonly exitTimeoutSeconds: number;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function renderPlist(options: PlistOptions): string {
  const str = (value: string) => `<string>${escapeXml(value)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${str(SERVICE_LABEL)}
  <key>ProgramArguments</key>
  <array>
    ${str(options.bunPath)}
    ${str('src/index.ts')}
  </array>
  <key>WorkingDirectory</key>
  ${str(options.repoDir)}
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    ${str(options.path)}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ExitTimeOut</key>
  <integer>${options.exitTimeoutSeconds}</integer>
  <key>ProcessType</key>
  ${str('Interactive')}
  <key>StandardOutPath</key>
  ${str(`${options.logDir}/agent.log`)}
  <key>StandardErrorPath</key>
  ${str(`${options.logDir}/agent.err.log`)}
</dict>
</plist>
`;
}
