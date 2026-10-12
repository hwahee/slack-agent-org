import { DESK_TOOLS } from './desk-tools';
import { INBOX_TOOLS } from './inbox-tools';
import type { Tool } from './types';

/** Everything the agent can do. Nothing here sends through Slack's API — by design. */
export const TOOLS: readonly Tool[] = [...DESK_TOOLS, ...INBOX_TOOLS];

/** The MCP server name; engines see the tools as `mcp__desk__<tool>`. */
export const TOOL_SERVER_NAME = 'desk';
