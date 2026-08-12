/**
 * retention.ts — retention bounds for persisted settings and import payloads.
 *
 * Pure, dependency-free bounds so both the Options layer (before a setting is
 * written) and the background (before an import is committed) enforce the same
 * quota-safe caps. Bounds are fail-closed: out-of-bounds values are clamped or
 * dropped, never persisted as-is, and never crash the caller.
 */

/** Maximum length of a persisted webhook URL. */
export const MAX_WEBHOOK_URL_LENGTH = 2048;

/** Generic cap for a single persisted settings string value. */
export const MAX_SETTING_STRING_LENGTH = 100_000;

/** Cap for array-shaped settings (allowlists, blocked domains, …) before
 *  persist — an unbounded list must not bypass the quota-safe caps this module
 *  exists to enforce. */
export const MAX_SETTING_ARRAY_LENGTH = 1000;

/** Cap the webhook URL before it is persisted (a hostile/typo'd value cannot
 *  balloon storage or the SSRF guard's input surface). */
export function clampWebhookUrl(value: string): string {
  return value.length > MAX_WEBHOOK_URL_LENGTH
    ? value.slice(0, MAX_WEBHOOK_URL_LENGTH)
    : value;
}

/**
 * Apply retention bounds to a settings object being persisted. Returns a NEW
 * object; the input is never mutated. Rules:
 * - `webhookUrl` is clamped to {@link MAX_WEBHOOK_URL_LENGTH}.
 * - Any string longer than {@link MAX_SETTING_STRING_LENGTH} is clamped.
 * - Non-finite numbers are dropped (they would corrupt downstream math).
 * The key name for the webhook URL is injectable so this lib module stays
 * independent of the options-layer storage key map.
 */
export function applySettingsRetention(
  values: Record<string, unknown>,
  webhookKey = "webhookUrl",
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) continue; // drop NaN/Infinity
      out[key] = value;
      continue;
    }
    if (typeof value === "string") {
      const clamped =
        value.length > MAX_SETTING_STRING_LENGTH
          ? value.slice(0, MAX_SETTING_STRING_LENGTH)
          : value;
      out[key] = key === webhookKey ? clampWebhookUrl(clamped) : clamped;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] =
        value.length > MAX_SETTING_ARRAY_LENGTH
          ? value.slice(0, MAX_SETTING_ARRAY_LENGTH)
          : value;
      continue;
    }
    out[key] = value;
  }
  return out;
}
