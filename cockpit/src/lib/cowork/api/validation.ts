import { z } from 'zod';
import { ClientError } from './http';

/**
 * Shared request-validation schemas.
 *
 * These exist so that free-form string fields accepted by the cockpit API are
 * bounded and (where the value is later interpreted, e.g. cron) vetted against a
 * safe grammar before they are ever stored. Bounding free-form strings prevents
 * stored-XSS / abuse if a future view renders them unsafely.
 */

/**
 * Truncate a string value to `max` chars.
 *
 * Mirrors `boundedString` in http.ts: it REJECTS non-string input instead of
 * silently coercing it. A bare `String(obj)` would persist `"[object Object]"`
 * and break the repo's type-safety invariant for free-text DB fields. A
 * present `undefined`/`null` falls back to `""`; callers that need a default
 * should coalesce before calling (e.g. `truncateTo(body.name ?? 'Untitled', 256)`).
 * Throws `ClientError` (→ 400) on non-string input so the value is rejected at
 * the API boundary rather than persisted as junk.
 */
export function truncateTo(value: unknown, max: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new ClientError('field must be a string');
  }
  return value.slice(0, max);
}

/** Zod helper: a bounded free-form string (0..max chars). */
export function boundedString(max: number): z.ZodString {
  return z.string().max(max);
}

/** Zod helper: a non-empty bounded string (1..max chars). */
export function nonEmptyString(max: number): z.ZodString {
  return boundedString(max).min(1);
}

/**
 * Safe cron-field grammar. Each of the five space-separated fields must be a
 * comma-separated list of components, where each component is one of:
 * • `*` (optionally followed by `/step`)
 * • a number (optionally `n/step`, `n-m`, or `n-m/step`)
 * • `?` (allowed for cron's day-of-month / day-of-week "no specific value")
 * This rejects the degenerate input the previous loose character class
 * permitted — bare `-` or `/`, leading/trailing/doubled separators, and token
 * soup such as `*,` or `5?`.
 */
// One component of a cron field, factored out so the (ReDoS-safe, anchored)
// grammar is defined exactly once and composed below. Kept disjoint so a `*` can
// carry only a step (never a range) and a numeric can carry a range or a step
// (never both) — this vetoes degenerate forms like `*-5` or `5/5-10`.
const CRON_STAR = '\\*(?:\\/[1-9]\\d*)?';
const CRON_NUM = '\\d+(?:-\\d+)?(?:\\/[1-9]\\d*)?';
const CRON_COMP = '(?:' + CRON_STAR + '|' + CRON_NUM + ')';
const CRON_FIELD = new RegExp(
  '^(?:\\?|' + CRON_COMP + '(?:,' + CRON_COMP + ')*)$',
);

/**
 * Validate a strict 5-field cron expression. Rejects anything containing shell
 * metacharacters and anything that is not exactly five space-separated fields,
 * each confined to the safe cron grammar above.
 */
export const scheduleCronSchema = z
  .string()
  .max(100)
  .refine(
    (val) => {
      const fields = val.trim().split(/\s+/);
      if (fields.length !== 5) return false;
      return fields.every((f) => f.length > 0 && CRON_FIELD.test(f));
    },
    { message: 'Invalid cron expression' },
  );

/** Parse-time result tuple used by the route helpers below. */
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * Run a zod schema's safeParse and fold the result into a typed
 * `{ ok, value }` / `{ ok, error }` so routes can return a 400 with a stable
 * message without leaking zod internals.
 */
export function validateField<T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
): ValidationResult<T> {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, error: `${label} is invalid` };
}
