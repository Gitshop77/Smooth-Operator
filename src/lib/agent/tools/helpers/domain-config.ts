/**
 * Domain config (allowlist/blocklist) used by the executor + handlers to
 * gate tab-level + content-script-level actions on the extension's domain
 * restrictions.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TRUST BOUNDARY — read this before relying on this module.
 *
 * Policy is currently carried via two mutable globals on `globalThis`
 * (`__openCoworkDomainConfig` and `__openCoworkDomainConfigEnforced`) that the
 * extension host populates synchronously before each action batch.
 *
 *  • In a Chrome *content script* (isolated world) page scripts cannot touch
 *    these globals, so enforcement is safe.
 *  • In the explicitly-supported *in-page demo* (same world as page JS), ANY
 *    page script can overwrite these globals — e.g. set
 *    `__openCoworkDomainConfigEnforced = false` to force allow-all. The
 *    fail-closed path (`isDomainConfigMissingButEnforced`) only triggers when
 *    the flag is set, so an untrusted page that simply never sets it gets
 *    allow-all. The demo must NEVER be run against untrusted pages.
 *
 * The long-term fix is to thread `domainConfig` explicitly (see
 * `checkUrlAllowedWithDomainConfig`'s optional `explicitConfig` parameter and
 * `setDomainConfig`), removing the `globalThis` side-channel entirely. Until the
 * executor/ActionContext threading lands in the host + loop layers, the global
 * path remains the fallback.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { checkUrlAllowed, type UrlPolicyResult } from "../../security";

/** Domain configuration shape returned by {@link getDomainConfig}. */
export interface DomainConfig {
  allowedDomains?: string[];
  blockedDomains?: string[];
}

const DOMAIN_CONFIG_KEY = "__openCoworkDomainConfig";
const DOMAIN_CONFIG_ENFORCED_KEY = "__openCoworkDomainConfigEnforced";

/**
 * Last-known-good policy. When an incoming `setDomainConfig` is missing or
 * malformed we retain this rather than silently downgrading to allow-all.
 */
let lastKnownGood: DomainConfig = {};

/**
 * Set when a `globalThis` policy read throws (e.g. a hostile/buggy accessor).
 * A throwing read must NOT be silently treated as "no policy" (allow-all) — we
 * fail CLOSED instead (see {@link checkUrlAllowedWithDomainConfig}).
 */
let policyReadFailed = false;

/**
 * Stable, shared reference for the "no policy / invalid policy" case. Returning
 * a single canonical object keeps `getDomainConfig` references identity-stable
 * across calls (so `toBe` assertions hold) while still meaning "allow-all".
 */
const EMPTY_CONFIG: DomainConfig = {};

/**
 * Read a global flag from `globalThis`. Reading a property off `globalThis`
 * virtually never throws; the try/catch is a defensive guard against a
 * throwing accessor. We deliberately do NOT gate these reads behind
 * `typeof chrome !== "undefined"` — the original code only consulted
 * `globalThis`, so behavior stays identical in the extension (chrome present,
 * global set) and the in-page demo (no global → default). Dropping the chrome
 * guard also keeps the flag testable outside the extension context.
 */
function readGlobal<T>(key: string): T | undefined {
  try {
    return (globalThis as Record<string, unknown>)[key] as T | undefined;
  } catch (err) {
    // A throwing getter (extremely rare) must NOT be silently downgraded to
    // "no policy" (allow-all). Flag it so the policy check fails CLOSED, and
    // surface the error so the failure is visible rather than masking a
    // legitimate error as a missing config.
    policyReadFailed = true;
    console.warn(`[domain-config] reading global "${key}" threw; failing closed:`, err);
    return undefined;
  }
}

function writeGlobal(key: string, value: unknown): void {
  (globalThis as Record<string, unknown>)[key] = value;
}

/**
 * Validate an unknown value as a {@link DomainConfig}.
 *
 * Returns `null` when the value is not a usable policy (missing, null, or not
 * an object) so callers can distinguish "not configured" from "configured but
 * empty". Per-field shape is checked: `allowedDomains` / `blockedDomains` must
 * each be `undefined` or an array of strings. A misconfigured payload (e.g.
 * `allowedDomains: "example.com"` instead of `["example.com"]`) is rejected
 * with a warning rather than passed through to `checkUrlAllowed`, where the
 * mismatch would surface as an opaque fail-closed "block everything".
 */
export function validateDomainConfig(cfg: unknown): DomainConfig | null {
  if (cfg === undefined || cfg === null) return null;
  if (typeof cfg !== "object" || Array.isArray(cfg)) return null;
  const c = cfg as Record<string, unknown>;
  const isStringArray = (v: unknown): v is string[] | undefined =>
    v === undefined || (Array.isArray(v) && v.every((x) => typeof x === "string"));
  if (!isStringArray(c.allowedDomains) || !isStringArray(c.blockedDomains)) {
    console.warn(
      "[domain-config] Ignoring invalid domainConfig: allowedDomains/blockedDomains must be string[] (or omitted).",
    );
    return null;
  }
  return {
    allowedDomains: c.allowedDomains as string[] | undefined,
    blockedDomains: c.blockedDomains as string[] | undefined,
  };
}

/**
 * Host-side setter for the domain policy.
 *
 * Unlike the raw `globalThis.__openCoworkDomainConfig = …` assignment performed
 * by `content.ts` today, this:
 *   • validates the shape (via {@link validateDomainConfig}) and ignores
 *     malformed payloads instead of installing a broken policy;
 *   • NEVER silently downgrades to allow-all — a missing/invalid `config`
 *     retains the last-known-good policy;
 *   • treats the explicit "no restrictions" state (`{}`) as a deliberate,
 *     validated value rather than the implicit default of an absent global.
 *
 * The host (extension `content.ts` / service-worker writer) should call this
 * instead of writing the globals directly.
 */
export function setDomainConfig(config?: DomainConfig, enforced?: boolean): void {
  const validated = config ? validateDomainConfig(config) : null;
  if (validated) {
    lastKnownGood = validated;
    writeGlobal(DOMAIN_CONFIG_KEY, validated);
  } else {
    // Missing or malformed config → retain the last-known-good policy rather
    // than overwriting with `undefined` (which `getDomainConfig` would treat
    // as `{}` → unrestricted navigation).
    writeGlobal(DOMAIN_CONFIG_KEY, lastKnownGood);
  }
  if (enforced !== undefined) {
    writeGlobal(DOMAIN_CONFIG_ENFORCED_KEY, enforced);
  }
}

/**
 * Whether a domain policy is EXPECTED to be enforced.
 *
 * The extension sets `globalThis.__openCoworkDomainConfigEnforced = true`
 * in the SAME place it sets `__openCoworkDomainConfig`, but ONLY when a
 * user-configured allow/block list exists. This lets the executor
 * distinguish two very different situations:
 *   - "no policy configured"      → allow-all is the intended default
 *     (fail-open by design);
 *   - "a policy WAS configured but the config payload is missing/unavailable"
 *     → fail CLOSED (the allow/block list is silently bypassed otherwise).
 *
 * Default (flag absent) = no enforcement expected = allow-all.
 */
export function isDomainPolicyEnforced(): boolean {
  return readGlobal<boolean>(DOMAIN_CONFIG_ENFORCED_KEY) === true;
}

/**
 * Get domain config (allowlist/blocklist) from the extension global or local
 * storage. In the in-page demo no domain restrictions are applied by default.
 *
 * The extension sets `globalThis.__openCoworkDomainConfig` synchronously
 * before running actions (because `chrome.storage.local` is async and we
 * can't `await` inside the synchronous executor dispatch).
 *
 * The returned value is validated for shape: a malformed payload yields the
 * stable {@link EMPTY_CONFIG} (allow-all) instead of being passed through
 * unvalidated. When the stored payload is valid we return its CANONICAL
 * reference (not a freshly-allocated copy) so repeated calls with the same
 * global return the SAME object identity — required for `toBe` equivalence
 * and avoids surprising aliasing bugs in callers that cache the result.
 */
export function getDomainConfig(): DomainConfig {
  const raw = readGlobal<unknown>(DOMAIN_CONFIG_KEY);
  if (raw === undefined) return EMPTY_CONFIG;
  if (validateDomainConfig(raw) === null) return EMPTY_CONFIG;
  return raw as DomainConfig;
}

/**
 * Whether a domain policy is expected (enforced) but the config payload is
 * currently missing/unavailable. In that case enforcement MUST fail closed.
 *
 * Exposed for callers + tests. A "configured but empty" policy
 * (`{ allowedDomains: [] }`) is treated as present (policyPresent=true), so
 * only a genuinely ABSENT config (`{}`/undefined) triggers the fail-closed
 * path when enforcement is expected.
 */
export function isDomainConfigMissingButEnforced(): boolean {
  const enforced = isDomainPolicyEnforced();
  const cfg = getDomainConfig();
  const policyPresent = !!(
    (cfg.allowedDomains && cfg.allowedDomains.length > 0) ||
    (cfg.blockedDomains && cfg.blockedDomains.length > 0)
  );
  return enforced && !policyPresent;
}

/**
 * Policy-aware URL check.
 *
 * Fails CLOSED (blocks) when a domain policy was configured
 * (`__openCoworkDomainConfigEnforced`) but the config payload
 * (`__openCoworkDomainConfig`) is missing/unavailable. This prevents a
 * silent allow-all bypass when the message that should have carried the
 * config lacked it.
 *
 * When no policy is enforced (the default), behavior is unchanged: an
 * empty/absent config means allow-all, exactly as before.
 *
 * @param explicitConfig When provided, the policy is taken from this argument
 *   instead of the `globalThis` side-channel. This is the path the executor
 *   should use once `domainConfig` is threaded through `LoopDeps` /
 *   `ActionContext`; the global remains a fallback for legacy callers.
 */
export function checkUrlAllowedWithDomainConfig(
  url: string,
  explicitConfig?: DomainConfig,
): UrlPolicyResult {
  if (explicitConfig) {
    return checkUrlAllowed(url, explicitConfig);
  }
  // A throwing global read means we cannot trust the policy state. Failing
  // closed here (regardless of the enforced flag) prevents a page that
  // tampered with / broke the policy global from silently downgrading to
  // allow-all. This is the fix for the readGlobal fail-open path.
  if (policyReadFailed) {
    return {
      allowed: false,
      reason: "Domain policy global read failed — blocking to fail closed.",
    };
  }
  if (isDomainConfigMissingButEnforced()) {
    return {
      allowed: false,
      reason: "Domain policy is enforced but the config is unavailable — blocking to fail closed.",
    };
  }
  return checkUrlAllowed(url, getDomainConfig());
}
