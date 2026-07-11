import { z } from 'zod';

/**
 * Shared request-validation schemas.
 *
 * These exist so that free-form string fields accepted by the cockpit API are
 * bounded and (where the value is later interpreted, e.g. cron) vetted against a
 * safe grammar before they are ever stored. Bounding free-form strings prevents
 * stored-XSS / abuse if a future view renders them unsafely.
 */

/** Truncate a value to `max` chars and return it as a string. */
export function truncateTo(value: unknown, max: number): string {
  return String(value ?? '').slice(0, max);
}

/** Zod helper: a bounded free-form string (0..max chars). */
export function boundedString(max: number): z.ZodString {
  return z.string().max(max);
}

/** Zod helper: a non-empty bounded string (1..max chars). */
export function nonEmptyString(max: number): z.ZodString {
  return z.string().min(1).max(max);
}

/**
 * Shell / injection metacharacters that must never appear in a cron
 * expression (the cockpit stores these and a future scheduler may shell out
 * or pass them to a cron parser). Covers `;`, `&`, `|`, `$`, backticks and
 * parentheses `(`, `)`.
 */
const CRON_FORBIDDEN = /[;&|`$()]/;

/**
 * Safe cron-field grammar: digits, `*`, `,`, `-`, `/`, `?`. Each of the five
 * space-separated fields must match this exactly.
 */
const CRON_FIELD = /^[\d*,\-/?]+$/;

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
      if (CRON_FORBIDDEN.test(val)) return false;
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
