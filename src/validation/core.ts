/**
 * Validation facade — public contract.
 *
 * Every consumer (config loading, Slack event parsing, tool arguments …)
 * depends only on the `Validator<T>` interface defined here. The actual schema
 * library (currently zod/mini, see ./zod-adapter.ts) is an implementation
 * detail and can be replaced by writing a new adapter — no consumer changes.
 */

/** A single, library-agnostic validation problem. */
export interface ValidationIssue {
  /** Dotted path to the offending field, e.g. `"items.0.title"`. Empty for root. */
  readonly path: string;
  /** Human-readable, library-specific message. */
  readonly message: string;
  /** Stable machine-readable code, e.g. `"too_small"`. */
  readonly code: string;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

/** Thrown by `Validator.parse` when the input is invalid. */
export class ValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super(
      `Validation failed: ${issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ')}`,
    );
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

/**
 * The library-agnostic validator contract.
 *
 * Implementations must be pure: no I/O, no mutation of the input.
 */
export interface Validator<T> {
  /** Returns the parsed value or throws {@link ValidationError}. */
  parse(input: unknown): T;
  /** Never throws; returns a discriminated result instead. */
  safeParse(input: unknown): ValidationResult<T>;
}

/**
 * A validator that can also describe its input as JSON Schema — what a model
 * needs to call a tool. One definition serves both, so the schema the model
 * sees and the check its arguments pass can never drift apart.
 */
export interface DescribedValidator<T> extends Validator<T> {
  readonly jsonSchema: Readonly<Record<string, unknown>>;
}

/** Extracts the output type of a validator: `Infer<typeof myValidator>`. */
export type Infer<V> = V extends Validator<infer T> ? T : never;
