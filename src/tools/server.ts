/**
 * The desk, served over MCP (Streamable HTTP) on localhost.
 *
 * Any engine that speaks MCP sits at the same desk: today `claude -p`, later a
 * GPT agent's runner. The listener binds 127.0.0.1 only and every request must
 * carry a bearer token minted at boot and handed to the engine — no other
 * process on the machine can move this agent's mouse.
 *
 * Stateless: each request gets a fresh MCP server bound to the shared context
 * (desk, inbox, turn), so there is no session bookkeeping to leak.
 */
import { timingSafeEqual } from 'node:crypto';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { Logger } from '../lib/log';
import { text, type Tool, type ToolContext, type ToolResult } from './types';

export interface ToolServer {
  /** `http://127.0.0.1:<port>/mcp` */
  readonly url: string;
  /** Bearer token the engine must send. */
  readonly token: string;
  stop(): Promise<void>;
}

export interface ToolServerOptions {
  readonly tools: readonly Tool[];
  readonly context: ToolContext;
  /** 0 = any free port. */
  readonly port: number;
  readonly log: Logger;
}

/** The notice that rides on tool results while new messages wait — a badge, not an interruption. */
function badge(unseen: number): string {
  return `🔔 새 Slack 메시지 ${unseen}건 — 안전한 지점에서 inbox_peek로 확인할 수 있습니다.`;
}

function sameToken(given: string | null, expected: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(`Bearer ${expected}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

function createMcpServer({ tools, context, log }: ToolServerOptions): Server {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const server = new Server({ name: 'desk', version: '1.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { type: 'object' as const, ...tool.inputSchema },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: input } = request.params;
    const tool = byName.get(name);
    let result: ToolResult = tool
      ? await tool.call(input, context)
      : { content: [text(`알 수 없는 도구: ${name}`)], isError: true };

    log.debug('tool called', { tool: name, input, isError: result.isError ?? false });
    if (context.inbox.unseenCount > 0) {
      result = { ...result, content: [...result.content, text(badge(context.inbox.unseenCount))] };
    }
    return { content: [...result.content], isError: result.isError ?? false };
  });

  return server;
}

export function startToolServer(options: ToolServerOptions): ToolServer {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');

  const http = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port,
    async fetch(request) {
      if (new URL(request.url).pathname !== '/mcp') return new Response(null, { status: 404 });
      if (!sameToken(request.headers.get('authorization'), token)) {
        return new Response(null, { status: 401 });
      }
      const mcp = createMcpServer(options);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
        enableJsonResponse: true,
      });
      await mcp.connect(transport);
      try {
        return await transport.handleRequest(request);
      } finally {
        await mcp.close();
      }
    },
  });

  const url = `http://127.0.0.1:${http.port}/mcp`;
  options.log.info('desk tool server listening', { url });
  return {
    url,
    token,
    async stop() {
      await http.stop();
    },
  };
}
