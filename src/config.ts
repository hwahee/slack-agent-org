/**
 * Configuration — every machine-dependent value enters the process here,
 * validated once at boot. Moving the agent to another machine (or giving this
 * machine to another agent) is a pure `.env` change; no code changes.
 * Secrets are only ever read from the environment (see .env.example).
 */
import { s, toValidator, type Infer } from './validation';

const slackUserId = s.string().check(s.regex(/^[UW][A-Z0-9]{2,}$/, 'a Slack user id (U…/W…)'));

const configValidator = toValidator(
  s.object({
    /** Who this agent is. The name appears in its own prompt; the id is how Slack knows it. */
    agentName: s.string().check(s.minLength(1)),
    agentSlackUserId: slackUserId,
    /**
     * People in the workspace. A message from one of them resets the loop guard
     * (`maxAgentExchanges`), so at least one is required.
     */
    humanSlackUserIds: s.array(slackUserId).check(s.minLength(1)),
    /** App-level token (Socket Mode connection). Receives only. */
    slackAppToken: s.string().check(s.startsWith('xapp-')),
    /** User or bot token for READ lookups (names). Refused at boot if it can write. */
    slackReadToken: s.string().check(s.regex(/^xox[bp]-/, 'an xoxb- or xoxp- token')),
    /** Which Slack client the agent works in. No difference in principle (CLAUDE.md). */
    slackClient: s._default(s.enum(['desktop', 'web']), 'desktop'),
    /**
     * After this many messages from the agent in a channel with no human in
     * between, it stops answering non-humans there (agent ↔ agent loop guard).
     */
    maxAgentExchanges: s._default(s.int().check(s.gte(1), s.lte(50)), 4),

    /** The engine that thinks. Drivers are swapped here, never in code. */
    engineDriver: s._default(s.enum(['claude-cli']), 'claude-cli'),
    claudeBin: s._default(s.string().check(s.minLength(1)), 'claude'),
    /** Model alias or full name; unset = the CLI's default. */
    claudeModel: s.optional(s.string().check(s.minLength(1))),
    /** Upper bound on tool round trips in one turn — a runaway brake, not an interrupt. */
    engineMaxTurns: s._default(s.int().check(s.gte(1), s.lte(500)), 80),

    /** Compiled desk helper (bun run desk:build). */
    deskHelperPath: s._default(s.string().check(s.minLength(1)), '.bin/desk-helper'),
    /** Longest edge, in pixels, of the screenshots the model sees. */
    deskMaxEdge: s._default(s.int().check(s.gte(640), s.lte(2560)), 1440),
    /** Localhost port of the desk tool server; 0 = any free port. */
    toolsPort: s._default(s.int().check(s.gte(0), s.lte(65535)), 0),

    /** Time zone for times shown to the agent — the only place the process leaves UTC. */
    timeZone: s._default(
      s.string().check(
        s.refine((zone) => {
          try {
            new Intl.DateTimeFormat('en', { timeZone: zone });
            return true;
          } catch {
            return false;
          }
        }, 'an IANA time zone, e.g. Asia/Seoul'),
      ),
      'Asia/Seoul',
    ),

    /** State (sessions, queue), logs, screenshots and the engine's working directory. */
    dataDir: s._default(s.string().check(s.minLength(1)), 'data'),
  }),
);

export type Config = Infer<typeof configValidator>;

function numberOrUndefined(value: string | undefined): number | undefined {
  return value === undefined || value === '' ? undefined : Number(value);
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === '' ? undefined : value;
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const config = configValidator.parse({
    agentName: env.AGENT_NAME,
    agentSlackUserId: env.AGENT_SLACK_USER_ID,
    humanSlackUserIds: list(env.HUMAN_SLACK_USER_IDS),
    slackAppToken: env.SLACK_APP_TOKEN,
    slackReadToken: env.SLACK_READ_TOKEN,
    slackClient: emptyToUndefined(env.SLACK_CLIENT),
    maxAgentExchanges: numberOrUndefined(env.MAX_AGENT_EXCHANGES),
    engineDriver: emptyToUndefined(env.ENGINE_DRIVER),
    claudeBin: emptyToUndefined(env.CLAUDE_BIN),
    claudeModel: emptyToUndefined(env.CLAUDE_MODEL),
    engineMaxTurns: numberOrUndefined(env.ENGINE_MAX_TURNS),
    deskHelperPath: emptyToUndefined(env.DESK_HELPER_PATH),
    deskMaxEdge: numberOrUndefined(env.DESK_MAX_EDGE),
    toolsPort: numberOrUndefined(env.TOOLS_PORT),
    timeZone: emptyToUndefined(env.TIME_ZONE),
    dataDir: emptyToUndefined(env.DATA_DIR),
  });

  if (config.humanSlackUserIds.includes(config.agentSlackUserId)) {
    // The loop guard would never engage: every own message would also count as human.
    throw new Error('AGENT_SLACK_USER_ID must not be listed in HUMAN_SLACK_USER_IDS');
  }
  return config;
}
