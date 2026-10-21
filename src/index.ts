/**
 * Entrypoint — one process is one agent at one desk.
 *
 *   bun run start              # foreground (first runs, debugging)
 *   bun run service:install    # always on, via launchd (docs/mac-setup.md)
 *
 * Boot order matters: the read token is proven read-only BEFORE anything is
 * received, and the desk tool server is up BEFORE the engine is handed its
 * address. Shutdown is cooperative like everything else: stop listening, let
 * the turn in progress end, save what is still waiting, set the Slack status,
 * exit. The status is also set as work starts (src/agent/status.ts).
 */
import { resolve } from 'node:path';

import { shutdownStatus, statusLook, type AgentStatus } from './agent/status';
import { loadConfig } from './config';
import { createContainer } from './container';
import { describeError, type Logger } from './lib/log';
import type { Desk } from './desk/types';
import { clearRestart, restartRequested } from './ops/restart';
import { STATUS_SCOPE } from './slack/scopes';

// Policy: the process lives in UTC; only times shown to the agent are local.
process.env.TZ = 'UTC';

const config = loadConfig();
const container = createContainer(config);
const { log } = container;

const scopes = await container.directory().assertReadOnly();
const statusOn = config.slackStatus === 'on' && scopes.includes(STATUS_SCOPE);
if (config.slackStatus === 'on' && !statusOn) {
  log.error('SLACK_STATUS=on but the read token lacks the status scope; the status is left as is', {
    fix: `add ${STATUS_SCOPE} to the app's User Token Scopes and reinstall, or set SLACK_STATUS=off`,
  });
}

/** Sets the Slack status (an API call, src/slack/status.ts); a failure is logged, never fatal. */
async function setStatus(status: AgentStatus, leftOver = 0): Promise<void> {
  if (!statusOn) return;
  const look = statusLook(status, leftOver);
  try {
    await container.status().set(look);
    log.info('slack status set', { status, emoji: look.emoji, text: look.text });
  } catch (error) {
    log.warn('setting the Slack status failed', { status, error: describeError(error) });
  }
}

const dataDir = resolve(config.dataDir);
// A restart marker belongs to the shutdown it announced, which is over by now;
// this process's own shutdown is a new question.
await clearRestart(dataDir);

const runtime = container.runtime();
runtime.restore(await container.state().loadQueue());
container.toolServer(); // listening before the first turn

const intake = container.intake();
await container.listener().start((event) => {
  intake(event).catch((error: unknown) => {
    log.error('intake failed', { error: describeError(error) });
  });
});

/**
 * Holds every turn until the desk can see and act. Messages heard meanwhile
 * wait in the queue — an agent that cannot see the screen would only flail
 * (or be tempted to click "Allow" on its own permission prompt).
 */
async function untilDeskReady(
  desk: Desk,
  logger: Logger,
  signal: AbortSignal,
  onBlocked: () => Promise<void>,
): Promise<void> {
  let told = false;
  for (;;) {
    const problem = await desk.problem();
    if (!problem) return;
    if (!told) {
      told = true;
      await onBlocked();
    }
    logger.error('desk not ready; holding turns until a person fixes it', {
      problem,
      fix: 'System Settings → Privacy & Security: allow this process (see docs/mac-setup.md 4)',
    });
    await Promise.race([
      Bun.sleep(30_000),
      new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })),
    ]);
    if (signal.aborted) return;
  }
}

const stop = new AbortController();
const running = untilDeskReady(container.desk(), log, stop.signal, () => setStatus('blocked')).then(
  async () => {
    if (stop.signal.aborted) return;
    await setStatus('working');
    await runtime.run(stop.signal);
  },
);
log.info('agent ready', {
  agent: config.agentName,
  engine: config.engineDriver,
  slackClient: config.slackClient,
});

// ── Graceful shutdown ───────────────────────────────────────────────────────
// First signal: stop hearing, let the current turn finish, save the queue,
// then set the Slack status (SLACK_STATUS): restarting, off, or off with work
// left over.
// A second signal force-exits (the turn is abandoned; the queue as of the last
// finished turn is on disk).
//
// `bun run start` forwards the terminal's Ctrl+C to this process, which also
// gets it directly — one press arrives twice within milliseconds, so a repeat
// inside a second is the same press.
let shutdownStartedAt: number | undefined;
async function shutdown(signal: string): Promise<void> {
  if (shutdownStartedAt !== undefined) {
    if (Date.now() - shutdownStartedAt < 1_000) return;
    log.warn('forced shutdown', { signal });
    process.exit(1);
  }
  shutdownStartedAt = Date.now();
  log.info('shutdown initiated; waiting for the current turn to end', { signal });

  await container.listener().stop();
  await container.triage()?.stop();
  stop.abort();
  await running;
  await container.state().saveQueue(runtime.snapshot());

  const queue = runtime.snapshot();
  const leftOver = queue.pending.length + queue.suspended.length;
  const status = shutdownStatus({ restarting: await restartRequested(dataDir), leftOver });
  await setStatus(status, leftOver);
  await container.toolServer().stop();

  log.info('shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
