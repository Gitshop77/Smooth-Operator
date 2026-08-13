export const BLOCKED_PAGE_RE = /cannot access|can'?t access|chrome:\/\/|about:|edge:\/\/|not allowed|not permitted|forbidden/i;

const STEALTH_ENABLED_KEY = "stealthEnabled";

/**
 * Whether the anti-detection posture is active. DEFAULT-ON: a user who has
 * never touched the setting gets the full stealth posture (MAIN-world
 * anti-detection patches applied, page-visible artifacts suppressed). Only an
 * EXPLICIT `false` in storage disables it. This is the "full black void"
 * product default — the page should never see automation artifacts unless the
 * user deliberately opts out.
 */
export async function isStealthEnabled(): Promise<boolean> {
  try {
    const res = await chrome.storage.local.get(STEALTH_ENABLED_KEY);
    return res[STEALTH_ENABLED_KEY] !== false;
  } catch {
    // Storage unavailable: fail toward the stealth posture (fail-safe for the
    // default-on product stance — never leak artifacts because a read failed).
    return true;
  }
}

// ─── Sync cache for page-side artifacts ──────────────────────────────────────
//
// The phantom cursor, the visual overlay, and the shadow-piercer backdoor are
// SYNC DOM modules that mutate the page on the action/observation path — they
// cannot await a chrome.storage read. `isStealthEnabledSync` serves them from a
// module-level cache primed by the content script at startup
// (`refreshStealthEnabledCache`, wired in `extension/content.ts`).
//
// Unknown (never primed) defaults to ON (matching the default-on storage
// posture): page artifacts stay suppressed until an explicit opt-out is
// observed — a page must never see automation chrome by default.
let stealthEnabledCache: boolean | null = null;

/** Sync read of the stealthEnabled flag for DOM modules that cannot await
 *  storage. `true` until `refreshStealthEnabledCache` (or the test hook)
 *  primes the cache — page artifacts fail closed (suppressed) by default. */
export function isStealthEnabledSync(): boolean {
  return stealthEnabledCache !== false;
}

/** Read the flag from storage and refresh the sync cache. Returns the value. */
export async function refreshStealthEnabledCache(): Promise<boolean> {
  stealthEnabledCache = await isStealthEnabled();
  return stealthEnabledCache;
}

/** Test hook — set/clear the cached flag without touching chrome.storage. */
export function _setStealthEnabledCacheForTests(value: boolean | null): void {
  stealthEnabledCache = value;
}
