import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { silentLogger } from '../lib/log';
import { buildClaudeArgs, createClaudeCliEngine, parseStreamLine } from './claude-cli';
import { EngineError } from './types';

const tools = { name: 'desk', url: 'http://127.0.0.1:1/mcp', token: 'secret' };

describe('parseStreamLine', () => {
  test('reads the session, what the agent says and does, and the result', () => {
    expect(
      parseStreamLine('{"type":"system","subtype":"init","session_id":"s1","tools":[]}'),
    ).toEqual([{ kind: 'init', sessionId: 's1' }]);
    expect(
      parseStreamLine(
        JSON.stringify({
          type: 'assistant',
          session_id: 's1',
          message: {
            content: [
              { type: 'text', text: '확인해 볼게요' },
              { type: 'tool_use', name: 'mcp__desk__screenshot', input: {} },
            ],
          },
        }),
      ),
    ).toEqual([
      { kind: 'text', text: '확인해 볼게요' },
      { kind: 'tool', name: 'mcp__desk__screenshot' },
    ]);
    expect(
      parseStreamLine(
        '{"type":"result","subtype":"success","is_error":false,"session_id":"s1","result":"답장 보냄","total_cost_usd":0.12,"num_turns":7}',
      ),
    ).toEqual([
      {
        kind: 'result',
        sessionId: 's1',
        ok: true,
        summary: '답장 보냄',
        costUsd: 0.12,
        toolRoundTrips: 7,
      },
    ]);
  });

  test('an error result is not ok', () => {
    expect(
      parseStreamLine(
        '{"type":"result","subtype":"error_max_turns","is_error":true,"session_id":"s1"}',
      ),
    ).toEqual([{ kind: 'result', sessionId: 's1', ok: false, summary: 'error_max_turns' }]);
  });

  test('skips noise', () => {
    expect(parseStreamLine('not json')).toEqual([]);
    expect(parseStreamLine('{"type":"autocompact_state"}')).toEqual([]);
  });
});

describe('buildClaudeArgs', () => {
  const base = { bin: 'claude', maxTurns: 40, systemPrompt: 'You are…', tools };

  test('gives the agent the desk and nothing else', () => {
    const args = buildClaudeArgs(base, '/data/desk-mcp.json');
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    expect(after('--tools')).toBe('');
    expect(after('--mcp-config')).toBe('/data/desk-mcp.json');
    expect(args).toContain('--strict-mcp-config');
    expect(after('--allowedTools')).toBe('mcp__desk');
    expect(after('--permission-mode')).toBe('dontAsk');
    expect(after('--max-turns')).toBe('40');
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--model');
    expect(args.join(' ')).not.toContain('secret'); // the token stays in the 0600 file
  });

  test('picks a model when asked', () => {
    const args = buildClaudeArgs({ ...base, model: 'opus' }, '/x.json');
    expect(args.slice(-2)).toEqual(['--model', 'opus']);
  });
});

describe('createClaudeCliEngine', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'engine-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A stand-in `claude`: echoes the prompt back as the result. */
  async function fakeClaude(script: string): Promise<string> {
    const bin = join(dir, 'claude');
    await Bun.write(bin, `#!/bin/sh\n${script}\n`);
    await chmod(bin, 0o755);
    return bin;
  }

  function engine(bin: string) {
    return createClaudeCliEngine({
      bin,
      maxTurns: 10,
      systemPrompt: 'sys',
      tools,
      workDir: join(dir, 'workspace'),
      log: silentLogger,
    });
  }

  test('runs a turn and returns its result', async () => {
    const bin = await fakeClaude(`
prompt=$(cat)
echo '{"type":"system","subtype":"init","session_id":"new-1"}'
printf '{"type":"result","subtype":"success","is_error":false,"session_id":"new-1","result":"%s"}\\n' "$prompt"`);
    expect(await engine(bin).run({ prompt: 'hello' })).toEqual({
      sessionId: 'new-1',
      ok: true,
      summary: 'hello',
    });
    // The desk token went into a file only this user can read.
    const config = Bun.file(join(dir, 'workspace', 'desk-mcp.json'));
    expect(await config.text()).toContain('Bearer secret');
    expect(((await config.stat()).mode & 0o777).toString(8)).toBe('600');
  });

  test('fails loudly when the CLI gives no result', async () => {
    const bin = await fakeClaude('cat > /dev/null; echo "not logged in" >&2; exit 1');
    await expect(engine(bin).run({ prompt: 'hi' })).rejects.toThrow(EngineError);
  });
});
