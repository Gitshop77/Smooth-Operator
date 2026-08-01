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
 * • In a Chrome *content script* (isolated world) page scripts cannot touch
 * these globals, so enforcement is safe.
 * • In the explicitly-supported *in-page demo* (same world as page JS), ANY
 * page script can overwrite these globals — e.g. set
 * `__openCoworkDomainConfigEnforced = false` to force allow-all. The
 * fail-closed path (`isDomainConfigMissingButEnforced`) only triggers when
 * the flag is set, so an untrusted page that simply never sets it gets
 * allow-all. The demo must NEVER be run against untrusted pages.
 *
 * The long-term fix is to thread `domainConfig` explicitly (see
 * `checkUrlAllowedWithDomainConfig`'s optional `explicitConfig` parameter and
 * `setDomainConfig`), removing the `globalThis` side-channel entirely. Until the
 * executor/ActionContext threading lands in the host + loop layers, the global
 * path remains the fallback.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { checkUrlAllowed, type UrlPolicyResult } from "../../security";
import {
  type DomainConfig,
  validateDomainConfig,
  freezeConfigInPlace,
  EMPTY_CONFIG,
} from "./domain-config-utils";

export { type DomainConfig, validateDomainConfig } from "./domain-config-utils";

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
 * Host-side setter for the domain policy.
 *
 * Unlike the raw `globalThis.__openCoworkDomainConfig = …` assignment performed
 * by `content.ts` today, this:
 * • validates the shape (via {@link validateDomainConfig}) and ignores
 * malformed payloads instead of installing a broken policy;
 * • NEVER silently downgrades to allow-all — a missing/invalid `config`
 * retains the last-known-good policy;
 * • treats the explicit "no restrictions" state (`{}`) as a deliberate,
 * validated value rather than the implicit default of an absent global.
 *
 * The host (extension `content.ts` / service-worker writer) should call this
 * instead of writing the globals directly.
 */
export function setDomainConfig(config?: DomainConfig, enforced?: boolean): void {
  const validated = config ? validateDomainConfig(config) : null;
  if (validated) {
    lastKnownGood = validated;
    writeGlobal(DOMAIN_CONFIG_KEY, validated);
  } else if (enforced === false) {
 // Explicitly disabling enforcement means allow-all: clear any prior
 // allow/block list rather than retaining lastKnownGood, so enforced=false
 // actually drops URL filtering (matching the documented contract).
    writeGlobal(DOMAIN_CONFIG_KEY, EMPTY_CONFIG);
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
 * - "no policy configured" → allow-all is the intended default
 * (fail-open by design);
 * - "a policy WAS configured but the config payload is missing/unavailable"
 * → fail CLOSED (the allow/block list is silently bypassed otherwise).
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
 * unvalidated. When the stored payload is valid we return the CANONICAL stored
 * config object (the live global) so repeated reads keep a STABLE reference —
 * required for `toBe` equivalence and avoids surprising aliasing bugs in
 * callers that cache the result. The returned object is frozen in place so
 * callers cannot mutate the shared/authoritative policy.
 */
export function getDomainConfig(): DomainConfig {
  const raw = readGlobal<unknown>(DOMAIN_CONFIG_KEY);
  if (raw === undefined) return EMPTY_CONFIG;
  if (validateDomainConfig(raw) === null) return EMPTY_CONFIG;
 // Return the CANONICAL stored config object (the live global) so repeated
 // reads keep a STABLE reference — required for `toBe` identity and the
 // caching assumption other callers rely on. The stored object is frozen in
 // place so callers cannot mutate the shared enforcement policy, while the
 // returned reference stays identical to the stored global object.
  return freezeConfigInPlace(raw as DomainConfig);
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
  if (!enforced) return false;
 // A policy is "present" when the config global EXISTS and validates — even if
 // it is deliberately empty (`{}` or `{ allowedDomains: [] }`). Distinguishing
 // empty-from-missing explicitly is required so a configured-but-empty policy
 // is NOT mis-handled as absent (which would wrongly trigger fail-closed).
 // Only a genuinely absent or malformed config counts as missing.
  const raw = readGlobal<unknown>(DOMAIN_CONFIG_KEY);
  const policyPresent = raw !== undefined && validateDomainConfig(raw) !== null;
  return !policyPresent;
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
 * instead of the `globalThis` side-channel. This is the path the executor
 * should use once `domainConfig` is threaded through `LoopDeps` /
 * `ActionContext`; the global remains a fallback for legacy callers.
 */
export function checkUrlAllowedWithDomainConfig(
  url: string,
  explicitConfig?: DomainConfig,
): UrlPolicyResult {
  if (explicitConfig) {
    return checkUrlAllowed(url, explicitConfig);
  }
 // Reset the sticky read-failure flag before this call's reads re-evaluate it.
 // Without this, a single transient throw would leave `policyReadFailed` true
 // for the entire run (permanent fail-closed) even after the condition cleared.
  policyReadFailed = false;
 // Perform the policy reads FIRST so `readGlobal` can (re)set
 // `policyReadFailed` if a global accessor throws. The previous ordering
 // checked the flag BEFORE any read ran, so it was always `false` here and the
 // guard failed OPEN. Evaluating the enforced/missing check now drives those
 // reads before we inspect the flag.
  const missingButEnforced = isDomainConfigMissingButEnforced();
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
  if (missingButEnforced) {
    return {
      allowed: false,
      reason: "Domain policy is enforced but the config is unavailable — blocking to fail closed.",
    };
  }
  const cfg = getDomainConfig();
  if (policyReadFailed) {
    return {
      allowed: false,
      reason: "Domain policy global read failed — blocking to fail closed.",
    };
  }
  return checkUrlAllowed(url, cfg);
}
