/**
 * Minimal structured logger facade. Swap the implementation (e.g. for pino)
 * without touching call sites — they only depend on the `Logger` interface.
 * One JSON object per line, so launchd's log files stay greppable.
 */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

export function createLogger(scope: string): Logger {
  const write = (level: Level, message: string, fields?: Record<string, unknown>) => {
    const line = {
      time: new Date().toISOString(), // UTC, like everything else in the process
      level,
      scope,
      message,
      ...fields,
    };
    console[level === 'debug' ? 'log' : level](JSON.stringify(line));
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  };
}

/** Logger that swallows everything — used in tests to keep output clean. */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Error → loggable string, for `catch (error: unknown)`. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
