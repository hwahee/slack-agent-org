/**
 * Installs, restarts or removes the agent's launchd service (macOS).
 *
 *   bun run service:install     # write the LaunchAgent and start it
 *   bun run service:restart     # stop gracefully; launchd starts it again
 *   bun run service:uninstall   # stop and remove
 *
 * Run `bun run doctor` first: a service that cannot see the screen restarts
 * forever without saying much.
 */
import { mkdir, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { renderPlist, SERVICE_LABEL } from '../src/ops/launchd';
import { markRestart } from '../src/ops/restart';

const repoDir = resolve(import.meta.dir, '..');
const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
const target = `gui/${process.getuid?.() ?? 501}`;

async function launchctl(...args: string[]): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn(['launchctl', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const output =
    (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  return { code: await proc.exited, output: output.trim() };
}

async function install(): Promise<void> {
  // The real binary, not a symlink: macOS privacy permissions attach to it.
  const bunPath = await realpath(process.execPath);
  const claude = Bun.which(process.env.CLAUDE_BIN ?? 'claude');
  if (!claude) throw new Error('claude CLI not found on PATH — see docs/mac-setup.md');

  const path = [
    ...new Set([
      dirname(bunPath),
      dirname(claude),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ]),
  ].join(':');
  const logDir = join(repoDir, 'data', 'logs');
  await mkdir(logDir, { recursive: true });
  await mkdir(dirname(plistPath), { recursive: true });
  await Bun.write(
    plistPath,
    renderPlist({ bunPath, repoDir, logDir, path, exitTimeoutSeconds: 600 }),
  );

  await launchctl('bootout', `${target}/${SERVICE_LABEL}`); // fine if it was not loaded
  const { code, output } = await launchctl('bootstrap', target, plistPath);
  if (code !== 0) throw new Error(`launchctl bootstrap failed: ${output}`);

  console.log(`installed ${plistPath}`);
  console.log(`logs: ${logDir}/agent.log`);
  console.log(`grant Accessibility + Screen Recording to: ${bunPath}`);
}

async function restart(): Promise<void> {
  // Same SIGTERM as a stop; the marker is how the agent knows to say "back soon".
  const configured = process.env.DATA_DIR; // same default as src/config.ts
  const dataDir = resolve(
    repoDir,
    configured === undefined || configured === '' ? 'data' : configured,
  );
  await mkdir(dataDir, { recursive: true });
  await markRestart(dataDir);
  const { code, output } = await launchctl('kill', 'SIGTERM', `${target}/${SERVICE_LABEL}`);
  if (code !== 0) throw new Error(`launchctl kill failed: ${output}`);
  console.log('SIGTERM sent — the agent finishes its current turn, then launchd starts it again');
}

async function uninstall(): Promise<void> {
  await launchctl('bootout', `${target}/${SERVICE_LABEL}`);
  await rm(plistPath, { force: true });
  console.log(`removed ${plistPath}`);
}

const commands: Record<string, () => Promise<void>> = { install, restart, uninstall };
const command = commands[process.argv[2] ?? ''];
if (process.platform !== 'darwin') throw new Error('the service runs on macOS only');
if (!command) throw new Error('usage: bun run scripts/service.ts install|restart|uninstall');
await command();
