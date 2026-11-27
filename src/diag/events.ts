/**
 * The diagnostics contract — what every record and the status snapshot look
 * like. docs/diagnostics.md is the human-readable copy; this file is the one
 * the code and the tests follow. An observer outside the process (the testbed)
 * reads these files and nothing else, so:
 *
 *   - adding a field or a kind keeps `DIAG_VERSION`;
 *   - renaming, removing or changing the meaning of one bumps it.
 *
 * Objects are strict on purpose: a field that is not listed here fails the
 * tests, so message text, names or tokens cannot slip in unnoticed.
 */
import { s, toValidator, type Infer, type Validator } from '../validation';

export const DIAG_VERSION = 1;

const int = () => s.int();
const ms = () => s.number();
const iso = () => s.string();

const outcome = s.enum(['queued', 'overheard', 'not-delivered', 'remember-only']);

/** Fields of each kind, beyond the common ones (`v`, `t`, `mono`, `boot`, `seq`, `kind`). */
const kinds = {
  'process.booted': s.strictObject({
    pid: int(),
    bunVersion: s.string(),
    config: s.strictObject({
      pollMinutes: int(),
      catchup: s.enum(['on', 'off']),
      catchupMaxHours: int(),
      slackStatus: s.enum(['on', 'off']),
      channelTriage: s.enum(['on', 'off']),
      diagSnapshotSec: int(),
      diagRetentionDays: int(),
    }),
  }),
  'process.shutdown': s.strictObject({
    phase: s.enum(['started', 'completed', 'forced']),
    signal: s.string(),
  }),
  'clock.gap': s.strictObject({
    expectedMs: ms(),
    wallElapsedMs: ms(),
    monoElapsedMs: ms(),
  }),
  'desk.state': s.strictObject({
    ready: s.boolean(),
    problem: s.optional(s.string()),
  }),

  'socket.url-requested': s.strictObject({
    conn: int(),
    ok: s.boolean(),
    ms: ms(),
    error: s.optional(s.string()),
  }),
  'socket.opened': s.strictObject({ conn: int(), msSinceRequest: ms() }),
  'socket.hello': s.strictObject({
    conn: int(),
    /** Always present when Slack sends it, 1 included. */
    numConnections: s.nullable(int()),
    helloAfterMs: ms(),
    debugHost: s.optional(s.string()),
    approximateConnectionTime: s.optional(s.number()),
  }),
  'socket.disconnect-requested': s.strictObject({
    conn: int(),
    reason: s.optional(s.string()),
    debugHost: s.optional(s.string()),
  }),
  'socket.error': s.strictObject({ conn: int(), message: s.string() }),
  'socket.closed': s.strictObject({
    conn: int(),
    code: int(),
    reason: s.string(),
    wasClean: s.boolean(),
    greeted: s.boolean(),
    livedMs: ms(),
    lastFrameAgoMs: s.nullable(ms()),
  }),
  'socket.reconnect-scheduled': s.strictObject({ delayMs: ms(), attempt: int() }),
  'socket.reconnect-failed': s.strictObject({ error: s.string(), nextDelayMs: ms() }),
  'socket.envelope': s.strictObject({
    conn: int(),
    type: s.string(),
    envelopeId: s.string(),
    retryAttempt: s.optional(int()),
    retryReason: s.optional(s.string()),
    eventId: s.optional(s.string()),
    eventTime: s.optional(s.number()),
    eventType: s.optional(s.string()),
    channel: s.optional(s.string()),
    channelType: s.optional(s.string()),
    ts: s.optional(s.string()),
    subtype: s.optional(s.string()),
  }),
  'socket.frame-unreadable': s.strictObject({ conn: int(), bytes: int() }),

  'message.observed': s.strictObject({
    /** `<channel>:<ts>` — the inbox id. */
    id: s.string(),
    path: s.enum(['socket', 'catchup']),
    channel: s.string(),
    ts: s.string(),
    user: s.optional(s.string()),
    receivedAt: iso(),
    /** receivedAt − ts. */
    delayMs: ms(),
    deliver: s.boolean(),
    reason: s.optional(s.string()),
    outcome,
  }),
  'inbox.taken': s.strictObject({
    by: s.enum(['turn-start', 'inbox_take']),
    messages: s.array(s.strictObject({ id: s.string(), waitedMs: ms() })),
  }),
  'turn.started': s.strictObject({
    conversation: s.string(),
    cause: s.enum(['messages', 'resume']),
    messageIds: s.array(s.string()),
  }),
  'turn.ended': s.strictObject({
    conversation: s.string(),
    ms: ms(),
    ok: s.boolean(),
    toolRoundTrips: s.optional(int()),
    costUsd: s.optional(s.number()),
    error: s.optional(s.string()),
  }),
  'triage.decided': s.strictObject({
    conversation: s.string(),
    judged: s.array(s.string()),
    outcome: s.enum(['answer', 'quiet', 'unreadable', 'failed']),
    ids: s.array(s.string()),
    ms: ms(),
  }),

  'poll.ran': s.strictObject({
    skipped: s.boolean(),
    ms: ms(),
    tasks: s.array(s.strictObject({ name: s.string(), ms: ms(), ok: s.boolean() })),
  }),
  'catchup.ran': s.strictObject({
    trigger: s.enum(['poll', 'connected', 'other']),
    ms: ms(),
    /** The very first run only sets the starting point. */
    firstRun: s.boolean(),
    since: s.optional(iso()),
    reads: s.optional(int()),
    found: s.optional(int()),
    answered: s.optional(int()),
    rememberedOnly: s.optional(int()),
    error: s.optional(s.string()),
  }),
  'heartbeat.beat': s.strictObject({
    outcome: s.enum(['working', 'blocked', 'left', 'failed']),
    problem: s.optional(s.string()),
  }),
};

export type DiagKind = keyof typeof kinds;

/** Fields per kind. */
export type DiagEvents = { [K in DiagKind]: s.output<(typeof kinds)[K]> };

const kindValidators = Object.fromEntries(
  Object.entries(kinds).map(([kind, schema]) => [kind, toValidator<unknown>(schema)]),
) as Record<DiagKind, Validator<unknown>>;

const envelopeValidator = toValidator(
  s.looseObject({
    v: s.literal(DIAG_VERSION),
    t: iso(),
    mono: s.number(),
    boot: s.string(),
    seq: int(),
    kind: s.enum(Object.keys(kinds) as [DiagKind, ...DiagKind[]]),
  }),
);

/** One line of `diag-YYYY-MM-DD.jsonl`. */
export type DiagRecord = Infer<typeof envelopeValidator> & Record<string, unknown>;

/** Checks a whole record — common fields and its kind's fields. Used by tests and the doctor. */
export function validateRecord(line: unknown): { ok: true } | { ok: false; problem: string } {
  const envelope = envelopeValidator.safeParse(line);
  if (!envelope.ok) return { ok: false, problem: envelope.issues.map((i) => i.path).join(', ') };
  const { v: _v, t: _t, mono: _m, boot: _b, seq: _s, kind, ...fields } = envelope.value;
  const result = kindValidators[kind].safeParse(fields);
  return result.ok
    ? { ok: true }
    : {
        ok: false,
        problem: `${kind}: ${result.issues.map((i) => `${i.path || '(root)'} ${i.message}`).join('; ')}`,
      };
}

// ── Status snapshot (`status.json`) ─────────────────────────────────────────

const sections = {
  socket: s.strictObject({
    conn: int(),
    live: s.boolean(),
    /** WebSocket readyState: 0 connecting, 1 open, 2 closing, 3 closed; null = no socket. */
    readyState: s.nullable(int()),
    bufferedAmount: s.nullable(int()),
    connectedAt: s.nullable(iso()),
    lastFrameAt: s.nullable(iso()),
    lastFrameType: s.nullable(s.string()),
    framesReceived: int(),
    /** Slack's WebSocket pings (Bun reports them; the pong stays automatic). */
    pingsReceived: int(),
    lastPingAt: s.nullable(iso()),
    lastEnvelopeAt: s.nullable(iso()),
    /** Successful connections after the first. */
    reconnects: int(),
  }),
  inbox: s.strictObject({
    pending: int(),
    unseen: int(),
    oldestWaitingMs: s.nullable(ms()),
  }),
  turn: s.strictObject({
    conversation: s.nullable(s.string()),
    startedAt: s.nullable(iso()),
    suspended: int(),
    failingTurns: int(),
  }),
  poll: s.strictObject({
    everyMs: ms(),
    lastStartedAt: s.nullable(iso()),
    lastEndedAt: s.nullable(iso()),
    nextAt: s.nullable(iso()),
  }),
  catchup: s.strictObject({
    lastRunAt: s.nullable(iso()),
    lastTrigger: s.nullable(s.string()),
    lastSince: s.nullable(iso()),
    lastFound: s.nullable(int()),
    lastError: s.nullable(s.string()),
  }),
};

export type SnapshotSection = keyof typeof sections;
export type SnapshotSections = { [K in SnapshotSection]: s.output<(typeof sections)[K]> };

const snapshotValidator = toValidator(
  s.strictObject({
    v: s.literal(DIAG_VERSION),
    writtenAt: iso(),
    mono: s.number(),
    boot: s.string(),
    pid: int(),
    sections: s.strictObject({
      socket: s.optional(sections.socket),
      inbox: s.optional(sections.inbox),
      turn: s.optional(sections.turn),
      poll: s.optional(sections.poll),
      catchup: s.optional(sections.catchup),
    }),
    clock: s.strictObject({ lastGapAt: s.nullable(iso()) }),
    diag: s.strictObject({ records: int(), writeErrors: int() }),
  }),
);

export type StatusSnapshot = Infer<typeof snapshotValidator>;

export function validateSnapshot(value: unknown): { ok: true } | { ok: false; problem: string } {
  const result = snapshotValidator.safeParse(value);
  return result.ok
    ? { ok: true }
    : {
        ok: false,
        problem: result.issues.map((i) => `${i.path || '(root)'} ${i.message}`).join('; '),
      };
}
