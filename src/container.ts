/**
 * Composition root — a tiny, typed service container.
 *
 * Everything resolved through the container is a per-process SINGLETON:
 * created lazily on first access, then memoized. It also owns driver choice
 * (which engine, which desk, which Slack doors, which state store), so swapping
 * infrastructure is invisible to the runtime. Tests swap drivers through
 * `overrides` — the same way the boilerplate swaps its database for memory.
 */
import { join, resolve } from 'node:path';

import { systemPrompt, triageSystemPrompt } from './agent/prompts';
import { Heartbeat } from './agent/heartbeat';
import { AgentRuntime } from './agent/runtime';
import { Triage } from './agent/triage';
import { UsageLedger } from './agent/usage';
import type { Config } from './config';
import { createMacDesk } from './desk/macos';
import type { Desk } from './desk/types';
import { createClaudeCliEngine, createClaudeCliJudge } from './engine/claude-cli';
import type { Engine, Judge } from './engine/types';
import { Addressing } from './inbox/addressing';
import { Catchup } from './inbox/catchup';
import { Inbox } from './inbox/inbox';
import { createIntake, type Intake } from './inbox/intake';
import { createLogger, type Logger } from './lib/log';
import { createWebDirectory } from './slack/directory';
import { createWebHistory } from './slack/history';
import { allowedWriteScopes } from './slack/scopes';
import { createSocketListener, openSocketUrl } from './slack/socket';
import { createWebStatus } from './slack/status';
import type { SlackDirectory, SlackHistory, SlackListener, SlackStatus } from './slack/types';
import { createFileStateStore } from './state/file';
import type { StateStore } from './state/types';
import { TOOL_SERVER_NAME, TOOLS } from './tools/catalog';
import { startToolServer, type ToolServer } from './tools/server';

export interface Container {
  readonly config: Config;
  readonly log: Logger;
  inbox(): Inbox;
  /** Who a message is for, and the agent ↔ agent loop guard. */
  addressing(): Addressing;
  /** Ears → inbox. */
  intake(): Intake;
  listener(): SlackListener;
  directory(): SlackDirectory;
  /** Read-only history, for the catch-up. */
  history(): SlackHistory;
  /** The agent's own Slack status — the one API write (src/slack/status.ts). */
  status(): SlackStatus;
  desk(): Desk;
  state(): StateStore;
  /** Starts listening on first access. */
  toolServer(): ToolServer;
  engine(): Engine;
  /** The tool-less quick look used by triage. */
  judge(): Judge;
  /** Null when channel triage is off. */
  triage(): Triage | null;
  runtime(): AgentRuntime;
  /** Daily model spending and the budget for agent-started work. */
  usage(): UsageLedger;
  /** Missed-message catch-up; null when CATCHUP is off. */
  catchup(): Catchup | null;
  /** The status heartbeat (call only while SLACK_STATUS works — see index.ts). */
  heartbeat(): Heartbeat;
}

export interface ContainerOverrides {
  log?: Logger;
  listener?: SlackListener;
  directory?: SlackDirectory;
  history?: SlackHistory;
  status?: SlackStatus;
  desk?: Desk;
  state?: StateStore;
  engine?: Engine;
  judge?: Judge;
}

/** This many failed turns in a row and the heartbeat stops calling the agent fine. */
const FAILING_TURNS_UNWELL = 3;

/** Memoizes a factory — the singleton primitive used for every service. */
function lazy<T>(factory: () => T): () => T {
  let created = false;
  let value: T;
  return () => {
    if (!created) {
      value = factory();
      created = true;
    }
    return value;
  };
}

export function createContainer(config: Config, overrides: ContainerOverrides = {}): Container {
  const log = overrides.log ?? createLogger(config.agentName);
  const dataDir = resolve(config.dataDir);

  const inbox = lazy(() => new Inbox());
  const listener = lazy(
    () =>
      overrides.listener ??
      createSocketListener({ openUrl: openSocketUrl(config.slackAppToken), log }),
  );
  const directory = lazy(
    () =>
      overrides.directory ??
      createWebDirectory(config.slackReadToken, log, {
        allowedWriteScopes: allowedWriteScopes(config.slackStatus),
      }),
  );
  const history = lazy(() => overrides.history ?? createWebHistory(config.slackReadToken));
  const status = lazy(() => overrides.status ?? createWebStatus(config.slackReadToken));
  const addressing = lazy(
    () =>
      new Addressing({
        agentUserId: config.agentSlackUserId,
        humanUserIds: config.humanSlackUserIds,
        maxAgentExchanges: config.maxAgentExchanges,
      }),
  );
  const intake = lazy(() => {
    const overheard = triage();
    return createIntake({
      addressing: addressing(),
      directory: directory(),
      inbox: inbox(),
      state: state(),
      ...(overheard && { triage: overheard }),
      log,
    });
  });

  const desk = lazy(
    () =>
      overrides.desk ??
      createMacDesk({
        helperPath: resolve(config.deskHelperPath),
        maxEdge: config.deskMaxEdge,
        workDir: join(dataDir, 'screen'),
      }),
  );
  const state = lazy(() => overrides.state ?? createFileStateStore(join(dataDir, 'state.json')));

  // The runtime and the tool server need each other (the inbox_yield tool
  // pauses the runtime's turn), so the tool context reaches the runtime lazily.
  const toolServer = lazy(() =>
    startToolServer({
      tools: TOOLS,
      context: {
        desk: desk(),
        inbox: inbox(),
        timeZone: config.timeZone,
        turn: { requestYield: (note) => runtime().requestYield(note) },
      },
      port: config.toolsPort,
      log,
    }),
  );

  const engine = lazy((): Engine => {
    if (overrides.engine) return overrides.engine;
    switch (config.engineDriver) {
      case 'claude-cli': {
        const server = toolServer();
        return createClaudeCliEngine({
          bin: config.claudeBin,
          ...(config.claudeModel && { model: config.claudeModel }),
          maxTurns: config.engineMaxTurns,
          systemPrompt: systemPrompt(config),
          tools: { name: TOOL_SERVER_NAME, url: server.url, token: server.token },
          workDir: resolve(config.engineWorkDir),
          log,
        });
      }
    }
  });

  const judge = lazy((): Judge => {
    if (overrides.judge) return overrides.judge;
    switch (config.engineDriver) {
      case 'claude-cli':
        return createClaudeCliJudge({
          bin: config.claudeBin,
          ...(config.triageModel && { model: config.triageModel }),
          systemPrompt: triageSystemPrompt(config),
          workDir: resolve(config.engineWorkDir),
          log,
        });
    }
  });

  const triage = lazy(() =>
    config.channelTriage === 'on'
      ? new Triage({
          judge: judge(),
          inbox: inbox(),
          state: state(),
          humanUserIds: config.humanSlackUserIds,
          timeZone: config.timeZone,
          waitMs: config.triageWaitSeconds * 1000,
          log,
          usage: usage(),
        })
      : null,
  );

  const usage = lazy(
    () =>
      new UsageLedger({
        state: state(),
        timeZone: config.timeZone,
        ...(config.dailyBudgetUsd !== undefined && { dailyBudgetUsd: config.dailyBudgetUsd }),
        log,
      }),
  );

  const catchup = lazy(() =>
    config.catchup === 'on'
      ? new Catchup({
          history: history(),
          state: state(),
          intake: intake(),
          maxAgeMs: config.catchupMaxHours * 60 * 60 * 1000,
          log,
        })
      : null,
  );

  const heartbeat = lazy(
    () =>
      new Heartbeat({
        status: status(),
        deskProblem: () => desk().problem(),
        otherProblem: () => {
          if (!listener().connected()) return 'slack connection down';
          const failing = runtime().failingTurns;
          return failing >= FAILING_TURNS_UNWELL ? `last ${failing} turns failed` : undefined;
        },
        template: config.heartbeatText,
        timeZone: config.timeZone,
        log,
      }),
  );

  const runtime = lazy(
    () =>
      new AgentRuntime({
        inbox: inbox(),
        engine: engine(),
        state: state(),
        timeZone: config.timeZone,
        log,
        usage: usage(),
      }),
  );

  return {
    config,
    log,
    inbox,
    addressing,
    intake,
    listener,
    directory,
    history,
    status,
    desk,
    state,
    toolServer,
    engine,
    judge,
    triage,
    runtime,
    usage,
    catchup,
    heartbeat,
  };
}
