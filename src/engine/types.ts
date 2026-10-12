/**
 * The brain — contract.
 *
 * An engine runs one turn: it reads the prompt, works at the desk through the
 * tools until it is done (or pauses itself), and reports back. Which engine
 * runs is configuration (ENGINE_DRIVER); the ears, the desk and the
 * cooperative-interruption rules are the same for all of them.
 */

export interface EngineTurn {
  readonly prompt: string;
  /** Continue this session (the conversation's memory); absent = start a new one. */
  readonly sessionId?: string;
}

export interface EngineResult {
  /** The session to continue next time. */
  readonly sessionId: string;
  /** False when the turn ended in an error (max turns, API error, …). */
  readonly ok: boolean;
  /** The engine's closing words — a work log, never shown to anyone in Slack. */
  readonly summary: string;
  readonly costUsd?: number;
  readonly toolRoundTrips?: number;
}

export interface Engine {
  run(turn: EngineTurn): Promise<EngineResult>;
}

/** The engine could not run a turn at all (not installed, not logged in, crashed). */
export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineError';
  }
}
