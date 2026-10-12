/**
 * Is this machine ready to be the agent's desk? Checks every outside thing the
 * agent depends on, in the order you would fix them, and says how to fix each.
 *
 *   bun run doctor
 *
 * Side effects: takes one screenshot (data/screen/screen.png), reads the text
 * on screen once, and opens and closes one Socket Mode connection. Nothing is
 * sent to Slack.
 */
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { loadConfig, type Config } from '../src/config';
import { createMacDesk, type DeskPermissions } from '../src/desk/macos';
import { describeError, silentLogger } from '../src/lib/log';
import { createWebDirectory } from '../src/slack/directory';
import { createSocketListener, openSocketUrl } from '../src/slack/socket';

let failures = 0;

async function check(name: string, run: () => Promise<string>, hint: string): Promise<boolean> {
  try {
    console.log(`✔ ${name} — ${await run()}`);
    return true;
  } catch (error) {
    failures += 1;
    console.log(`✘ ${name} — ${describeError(error)}\n    → ${hint}`);
    return false;
  }
}

async function command(...args: string[]): Promise<string> {
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(err.trim() || `exit ${code}`);
  return out.trim();
}

let config: Config | undefined;
await check(
  '.env',
  () => {
    config = loadConfig();
    return Promise.resolve(`${config.agentName} (${config.agentSlackUserId})`);
  },
  'cp .env.example .env 후 값을 채우세요 (docs/mac-setup.md 3단계)',
);
if (!config) process.exit(1);
const cfg = config;

// ── Desk ──────────────────────────────────────────────────────────────────────
const desk = createMacDesk({
  helperPath: resolve(cfg.deskHelperPath),
  maxEdge: cfg.deskMaxEdge,
  workDir: join(resolve(cfg.dataDir), 'screen'),
});
const bun = await realpath(process.execPath);

const helperBuilt = await check(
  'desk helper',
  async () => {
    if (!(await Bun.file(resolve(cfg.deskHelperPath)).exists())) throw new Error('not built');
    return resolve(cfg.deskHelperPath);
  },
  'bun run desk:build (Xcode Command Line Tools 필요: xcode-select --install)',
);

if (helperBuilt) {
  let permissions: DeskPermissions | undefined;
  await check(
    'display',
    async () => {
      const { width, height } = await desk.display();
      if (width === 0 || height === 0) throw new Error('no display');
      return `${width}×${height} pt`;
    },
    '화면이 있어야 합니다: 덮개를 열어 두거나 외부 모니터/HDMI 더미 플러그를 연결하세요',
  );
  await check(
    'accessibility (hands)',
    async () => {
      permissions = await desk.permissions();
      if (!permissions.accessibility || !permissions.screenRecording) {
        // Shows macOS's own prompts and puts the app into both lists in System Settings.
        permissions = await desk.requestPermissions();
      }
      if (!permissions.accessibility) throw new Error('not granted');
      return 'granted';
    },
    `방금 뜬 macOS 창에서 '시스템 설정 열기' → 목록의 터미널을 켜고, + 로 서비스용 ${bun} 도 추가하세요 ` +
      `(창이 없으면: open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')`,
  );
  await check(
    'screen recording (eyes)',
    async () => {
      if (!permissions?.screenRecording) throw new Error('not granted');
      const shot = await desk.screenshot();
      return `${shot.width}×${shot.height}px → ${join(cfg.dataDir, 'screen', 'screen.png')} (열어서 확인하세요)`;
    },
    `화면 녹음 목록의 터미널을 켜고, + 로 서비스용 ${bun} 도 추가하세요 ` +
      `(바로 열기: open 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')`,
  );
  await check(
    'cheap eyes (text, changes)',
    async () => {
      if (!permissions?.screenRecording) throw new Error('needs screen recording');
      const lines = await desk.readText();
      const changes = await desk.changes();
      if (!changes) throw new Error('no reference frame to compare with');
      const sample = lines
        .slice(0, 3)
        .map((line) => line.text)
        .join(' / ');
      return `${lines.length} lines read (${sample || 'no text on screen'}), changes compared`;
    },
    '도우미를 다시 빌드하세요: bun run desk:build (diff·ocr 명령이 없는 옛 빌드일 수 있습니다)',
  );
}

// ── Engine ────────────────────────────────────────────────────────────────────
await check(
  'claude CLI',
  async () => {
    const version = await command(cfg.claudeBin, '--version');
    const status = JSON.parse(await command(cfg.claudeBin, 'auth', 'status')) as {
      loggedIn?: boolean;
    };
    if (!status.loggedIn) throw new Error(`${version}, not logged in`);
    return `${version}, logged in`;
  },
  '설치: docs/mac-setup.md 2단계 · 로그인: claude auth login',
);

// ── Slack ─────────────────────────────────────────────────────────────────────
await check(
  'slack read token (read-only)',
  async () => {
    await createWebDirectory(cfg.slackReadToken, silentLogger).assertReadOnly();
    return 'no write scopes';
  },
  'SLACK_READ_TOKEN의 쓰기 scope(chat:write 등)를 앱 설정에서 빼고 다시 설치하세요',
);
await check(
  'slack socket mode',
  async () => {
    const listener = createSocketListener({
      openUrl: openSocketUrl(cfg.slackAppToken),
      log: silentLogger,
    });
    await listener.start(() => undefined);
    await Bun.sleep(5_000); // a connection that drops right away fails here, not in production
    await listener.stop();
    return 'connected and stayed connected for 5 s';
  },
  'Socket Mode를 켜고 connections:write scope의 App-Level Token(xapp-)을 SLACK_APP_TOKEN에 넣으세요',
);

console.log(failures === 0 ? '\n모두 준비됐습니다.' : `\n${failures}개 항목을 고쳐야 합니다.`);
process.exit(failures === 0 ? 0 : 1);
