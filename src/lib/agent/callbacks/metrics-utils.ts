import type { ActionCounts } from "./metrics";

/**
 * Validate and sanitize a numeric metric value (shared by token-count and
 * cost sanitizers — both require a finite number and reject everything else).
 * Returns the numeric value if valid, undefined otherwise.
 */
function sanitizeFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Validate and sanitize a token count value.
 * Returns the numeric value if valid, undefined otherwise.
 */
export const sanitizeTokenCount = sanitizeFiniteNumber;

/**
 * Validate and sanitize a cost value in USD.
 * Returns the numeric value if valid, undefined otherwise.
 */
export const sanitizeCostUsd = sanitizeFiniteNumber;

/**
 * Deep-clone a per-action-type counts record.
 */
export function cloneActionCounts(
  source: Record<string, ActionCounts>,
): Record<string, ActionCounts> {
  const result: Record<string, ActionCounts> = {};
  for (const [k, v] of Object.entries(source)) {
    result[k] = { ...v };
  }
  return result;
}
