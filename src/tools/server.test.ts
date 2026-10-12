import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createMemoryDesk, type MemoryDesk } from '../desk/memory';
import { Inbox } from '../inbox/inbox';
import { silentLogger } from '../lib/log';
import { inboxMessage } from '../testing/fixtures';
import { TOOLS } from './catalog';
import { startToolServer, type ToolServer } from './server';

let desk: MemoryDesk;
let inbox: Inbox;
let yields: string[];
let turnRunning: boolean;
let server: ToolServer;
let client: Client;

beforeEach(async () => {
  desk = createMemoryDesk();
  inbox = new Inbox();
  yields = [];
  turnRunning = true;
  server = startToolServer({
    tools: TOOLS,
    context: {
      desk,
      inbox,
      timeZone: 'Asia/Seoul',
      turn: {
        requestYield(note) {
          if (!turnRunning) return false;
          yields.push(note);
          return true;
        },
      },
    },
    port: 0,
    log: silentLogger,
  });
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${server.token}` } },
    }),
  );
});

afterEach(async () => {
  await client.close();
  await server.stop();
});

/** Calls a tool and returns its text parts joined, plus the error flag. */
async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text?: string }[];
  return {
    text: content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n'),
    types: content.map((c) => c.type),
    isError: result.isError === true,
  };
}

describe('tool server', () => {
  test('lists every desk and inbox tool with a JSON schema', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      'screenshot',
      'read_screen',
      'click',
      'move',
      'scroll',
      'type',
      'key',
      'wait',
      'inbox_peek',
      'inbox_take',
      'inbox_yield',
    ]);
    const click = tools.find((t) => t.name === 'click');
    expect(click?.inputSchema).toMatchObject({ type: 'object', required: ['x', 'y'] });
  });

  test('rejects requests without the token', async () => {
    const response = await fetch(server.url, { method: 'POST', body: '{}' });
    expect(response.status).toBe(401);
  });

  test('the hands act on the desk', async () => {
    expect((await call('screenshot')).types).toEqual(['image', 'text']);
    await call('click', { x: 10, y: 20, double: true });
    await call('type', { text: '안녕하세요' });
    await call('key', { combo: 'Shift+Enter' });
    await call('scroll', { x: 5, y: 5, lines: -3 });
    expect(desk.actions).toEqual([
      'screenshot',
      'click 10,20 left x2',
      'type 안녕하세요',
      'key shift+return',
      'scroll 5,5 -3',
    ]);
  });

  test('every action reports what changed on screen', async () => {
    desk.nextChanges = {
      ratio: 0.02,
      areas: [
        {
          box: { x: 100, y: 600, width: 400, height: 40 },
          lines: [
            { text: '네, 3시에 가능합니다.', box: { x: 110, y: 610, width: 200, height: 16 } },
          ],
        },
      ],
      omitted: 1,
    };
    const sent = await call('key', { combo: 'enter' });
    expect(sent.text).toContain('키: enter');
    expect(sent.text).toContain('화면 변화 1곳 (화면의 2%)');
    expect(sent.text).toContain('(100, 600)–(500, 640): "네, 3시에 가능합니다."');
    expect(sent.text).toContain('작은 변화 1곳 생략');

    expect((await call('wait', { seconds: 0.01 })).text).toContain('화면 변화: 없음');
    expect(desk.actions).toEqual(['key return']); // looking after an action is not an action
  });

  test('a failed look does not undo the action', async () => {
    desk.changes = () => Promise.reject(new Error('unknown command: diff'));
    const clicked = await call('click', { x: 1, y: 2 });
    expect(clicked.isError).toBe(false);
    expect(clicked.text).toContain('확인하지 못했습니다 (unknown command: diff)');
    expect(desk.actions).toEqual(['click 1,2 left x1']);
  });

  test('the cheap eye reads text, the expensive eye can look at a part', async () => {
    desk.screenText = [
      { text: '#team', box: { x: 10, y: 100, width: 60, height: 16 } },
      { text: '지훈', box: { x: 10, y: 130, width: 40, height: 16 } },
    ];
    expect((await call('read_screen')).text).toBe('(40, 108) #team\n(30, 138) 지훈');
    expect(
      (await call('read_screen', { region: { x: 0, y: 120, width: 200, height: 40 } })).text,
    ).toBe('(30, 138) 지훈');

    const part = await call('screenshot', { region: { x: 100, y: 50, width: 300, height: 200 } });
    expect(part.types).toEqual(['image', 'text']);
    expect(part.text).toContain('화면 좌표 (100 + a, 50 + b)');
    expect(desk.actions).toEqual([
      'read_screen',
      'read_screen 0,120,200,40',
      'screenshot 100,50,300,200',
    ]);
  });

  test('a bad call comes back as an error the model can correct', async () => {
    expect(await call('click', { x: -1, y: 0 })).toMatchObject({ isError: true });
    expect(await call('key', { combo: 'hyper+k' })).toMatchObject({ isError: true });
    const typed = await call('type', { text: '첫 줄\n둘째 줄' });
    expect(typed.isError).toBe(true);
    expect(typed.text).toContain('shift+enter');
    expect(desk.actions).toEqual([]); // nothing reached the desk
  });

  test('new messages show as a badge until the agent looks', async () => {
    inbox.push(inboxMessage('1.0', 'D1', '잠깐 시간 돼요?'));
    expect((await call('move', { x: 1, y: 1 })).text).toContain('새 Slack 메시지 1건');

    const peeked = await call('inbox_peek');
    expect(peeked.text).toContain('잠깐 시간 돼요?');
    expect(peeked.text).toContain('[D1:1.0] DM · 지훈');
    expect(peeked.text).not.toContain('🔔');

    expect((await call('move', { x: 1, y: 1 })).text).not.toContain('🔔');
    expect(inbox.size).toBe(1); // looking is not handling
  });

  test('take folds a message into the current turn', async () => {
    inbox.push(inboxMessage('1.0'));
    inbox.push(inboxMessage('2.0'));
    expect((await call('inbox_take', { ids: ['D1:2.0'] })).text).toContain('가져온 메시지 1건');
    expect(inbox.peek().map((m) => m.id)).toEqual(['D1:1.0']);
    expect(await call('inbox_take', { ids: ['nope'] })).toMatchObject({ isError: true });
  });

  test('yield hands the note to the runtime', async () => {
    expect((await call('inbox_yield', { note: '3단계까지 함' })).isError).toBe(false);
    expect(yields).toEqual(['3단계까지 함']);

    turnRunning = false;
    expect(await call('inbox_yield', { note: 'x' })).toMatchObject({ isError: true });
  });
});
