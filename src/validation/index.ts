/**
 * Validation facade — the single import point for schema validation.
 *
 *   import { s, toValidator, type Infer } from '../validation';
 *   export const inputValidator = toValidator(s.object({ name: s.string() }));
 *   export type Input = Infer<typeof inputValidator>;
 */
export type { DescribedValidator, Infer } from './core';
export { s, toDescribedValidator, toValidator } from './zod-adapter';
