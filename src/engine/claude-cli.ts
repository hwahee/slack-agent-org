/**
 * Engine driver: Claude Code CLI in print mode (`claude -p`).
 *
 * Runs with this machine's own Claude login — no API key in the process. Each
 * turn is one CLI run in a fresh session: what the agent remembers of a
 * conversation is in the prompt (the runtime keeps it), so no turn carries
 * the screens and clicks of every turn before it. The agent gets exactly the
 * desk tools and nothing else:
 *
 *   --tools ""             no built-in tools (no shell, no file edits)
 *   --strict-mcp-config    no MCP servers but the desk
 *   --allowedTools         the desk's tools run without prompts…
 *   --permission-mode      …and anything else is refused (dontAsk)
 *
 * The run is never cut short from outside (CLAUDE.md: cooperative only);
 * `--max-turns` is the brake for a run that will not end on its own.
 */
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { Logger } from '../lib/log';
import { s, toValidator } from '../validation';
import { EngineError, type Engine, type EngineResult } from './types';

export interface ClaudeCliOptions {
  readonly bin: string;
  readonly model?: string;
  readonly maxTurns: number;
  readonly systemPrompt: string;
  /** The desk tool server. */
  readonly tools: { readonly name: string; readonly url: string; readonly token: string };
  /** Engine working directory — outside any repository, so no CLAUDE.md is picked up. */
  readonly workDir: string;
  readonly log: Logger;
}

// ── stream-json parsing (pure) ────────────────────────────────────────────────

export type StreamEvent =
  | { readonly kind: 'init'; readonly sessionId: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'tool'; readonly name: string }
  | ({ readonly kind: 'result' } & EngineResult);

const lineValidator = toValidator(
  s.looseObject({
    type: s.string(),
    subtype: s.optional(s.string()),
    session_id: s.optional(s.string()),
    is_error: s.optional(s.boolean()),
    result: s.optional(s.string()),
    total_cost_usd: s.optional(s.number()),
    num_turns: s.optional(s.number()),
    message: s.optional(
      s.looseObject({
        content: s.optional(
          s.array(
            s.looseObject({
              type: s.string(),
              text: s.optional(s.string()),
              name: s.optional(s.string()),
            }),
          ),
        ),
      }),
    ),
  }),
);

/** One line of `--output-format stream-json` → the events the runtime cares about. */
export function parseStreamLine(line: string): StreamEvent[] {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return [];
  }
  const parsed = lineValidator.safeParse(json);
  if (!parsed.ok) return [];
  const event = parsed.value;

  if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
    return [{ kind: 'init', sessionId: event.session_id }];
  }
  if (event.type === 'assistant') {
    return (event.message?.content ?? []).flatMap((block): StreamEvent[] => {
      if (block.type === 'text' && block.text) return [{ kind: 'text', text: block.text }];
      if (block.type === 'tool_use' && block.name) return [{ kind: 'tool', name: block.name }];
      return [];
    });
  }
  if (event.type === 'result' && event.session_id) {
    return [
      {
        kind: 'result',
        sessionId: event.session_id,
        ok: event.subtype === 'success' && event.is_error !== true,
        summary: event.result ?? event.subtype ?? '',
        ...(event.total_cost_usd !== undefined && { costUsd: event.total_cost_usd }),
        ...(event.num_turns !== undefined && { toolRoundTrips: event.num_turns }),
      },
    ];
  }
  return [];
}

// ── command line (pure) ───────────────────────────────────────────────────────

export function buildClaudeArgs(
  options: Pick<ClaudeCliOptions, 'bin' | 'model' | 'maxTurns' | 'systemPrompt' | 'tools'>,
  mcpConfigPath: string,
): string[] {
  return [
    options.bin,
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--system-prompt',
    options.systemPrompt,
    '--tools',
    '',
    '--mcp-config',
    mcpConfigPath,
    '--strict-mcp-config',
    '--allowedTools',
    `mcp__${options.tools.name}`,
    '--permission-mode',
    'dontAsk',
    '--disable-slash-commands',
    '--max-turns',
    String(options.maxTurns),
    ...(options.model ? ['--model', options.model] : []),
  ];
}

// ── driver ────────────────────────────────────────────────────────────────────

export function createClaudeCliEngine(options: ClaudeCliOptions): Engine {
  const { log } = options;
  const mcpConfigPath = join(options.workDir, 'desk-mcp.json');
  let prepared: Promise<void> | undefined;

  /** The MCP config holds the desk token, so it goes in a file only this user can read. */
  function prepare(): Promise<void> {
    prepared ??= (async () => {
      await mkdir(options.workDir, { recursive: true });
      const { name, url, token } = options.tools;
      await Bun.write(
        mcpConfigPath,
        JSON.stringify({
          mcpServers: {
            [name]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } },
          },
        }),
      );
      await chmod(mcpConfigPath, 0o600);
    })();
    return prepared;
  }

  async function runOnce(prompt: string) {
    const proc = Bun.spawn(buildClaudeArgs(options, mcpConfigPath), {
      cwd: options.workDir,
      stdin: new Blob([prompt]),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderrText = new Response(proc.stderr).text();

    let result: EngineResult | undefined;
    let buffered = '';
    const decoder = new TextDecoder();
    const handle = (line: string) => {
      for (const event of parseStreamLine(line)) {
        if (event.kind === 'tool') log.debug('agent tool', { tool: event.name });
        else if (event.kind === 'text') log.debug('agent says', { text: event.text });
        else if (event.kind === 'init') log.debug('engine session', { sessionId: event.sessionId });
        else {
          const { kind: _kind, ...rest } = event;
          result = rest;
        }
      }
    };
    for await (const chunk of proc.stdout) {
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      lines.forEach(handle);
    }
    if (buffered) handle(buffered);

    const code = await proc.exited;
    return { result, code, stderr: (await stderrText).trim() };
  }

  return {
    async run({ prompt }) {
      await prepare();
      const attempt = await runOnce(prompt);
      if (!attempt.result) {
        throw new EngineError(
          `${options.bin} exited with ${attempt.code} and no result: ${attempt.stderr.slice(-500)}`,
        );
      }
      return attempt.result;
    },
  };
}
