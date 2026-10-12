/**
 * Tools — what the engine can do, whichever engine it is.
 *
 * Tools are served over MCP on localhost (./server.ts), so the same desk works
 * for a Claude engine today and a GPT engine later: every member of the
 * organization works at the same kind of desk, the same way.
 */
import type { Desk } from '../desk/types';
import type { Inbox } from '../inbox/inbox';
import type { DescribedValidator } from '../validation';

/** The runtime's side of cooperative interruption. */
export interface TurnControl {
  /**
   * The agent reached a safe point and pauses its current task with a note.
   * Returns false when no turn is running (nothing to pause).
   */
  requestYield(note: string): boolean;
}

export interface ToolContext {
  readonly desk: Desk;
  readonly inbox: Inbox;
  readonly turn: TurnControl;
  /** IANA zone for times shown to the agent (a display boundary). */
  readonly timeZone: string;
}

export type ToolContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: 'image/png' };

export interface ToolResult {
  readonly content: readonly ToolContent[];
  readonly isError?: boolean;
}

/** A tool with its input type erased — what the server holds. */
export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  call(input: unknown, context: ToolContext): Promise<ToolResult>;
}

export function text(value: string): ToolContent {
  return { type: 'text', text: value };
}

export function failure(message: string): ToolResult {
  return { content: [text(message)], isError: true };
}

/**
 * Declares a tool. Arguments are validated by the same schema the model is
 * shown; a bad call comes back to the model as an error it can correct, and
 * a thrown error (missing permission, …) does too — the turn goes on.
 */
export function defineTool<T>(spec: {
  name: string;
  description: string;
  input: DescribedValidator<T>;
  run(args: T, context: ToolContext): Promise<ToolResult>;
}): Tool {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.input.jsonSchema,
    async call(input, context) {
      const parsed = spec.input.safeParse(input ?? {});
      if (!parsed.ok) {
        return failure(
          `잘못된 인자: ${parsed.issues.map((i) => `${i.path || '(root)'} ${i.message}`).join('; ')}`,
        );
      }
      try {
        return await spec.run(parsed.value, context);
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
