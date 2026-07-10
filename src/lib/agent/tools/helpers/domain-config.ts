/**
 * Domain config (allowlist/blocklist) used by the executor + handlers to
 * gate tab-level + content-script-level actions on the extension's domain
 * restrictions.
 */

import { checkUrlAllowed, type UrlPolicyResult } from "../../security";

/** Domain configuration shape returned by {@link getDomainConfig}. */
export interface DomainConfig {
  allowedDomains?: string[];
  blockedDomains?: string[];
}

/**
 * Read a global flag from `globalThis`. Safe to call in any environment —
 * reading a property off `globalThis` never throws (and is wrapped in
 * try/catch defensively). We deliberately do NOT gate these reads behind a
 * `typeof chrome !== "undefined"` check: the original code only consulted
 * `globalThis.__openCoworkDomainConfig`, so the behavior is identical in
 * the extension (chrome present, global set) and the in-page demo (no
 * global → falls through to the default). Dropping the chrome guard also
 * makes the enforcement flag testable outside the extension context.
 */
function readGlobal<T>(key: string): T | undefined {
  try {
    return (globalThis as Record<string, unknown>)[key] as T | undefined;
  } catch {
    return undefined;
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
 * See F-07. Default (flag absent) = no enforcement expected = allow-all.
 */
export function isDomainPolicyEnforced(): boolean {
  return readGlobal<boolean>("__openCoworkDomainConfigEnforced") === true;
}

/**
 * Get domain config (allowlist/blocklist) from the extension global or local
 * storage. In the in-page demo no domain restrictions are applied by default.
 *
 * The extension sets `globalThis.__openCoworkDomainConfig` synchronously
 * before running actions (because `chrome.storage.local` is async and we
 * can't `await` inside the synchronous executor dispatch).
 */
export function getDomainConfig(): DomainConfig {
  const cfg = readGlobal<DomainConfig>("__openCoworkDomainConfig");
  return cfg && typeof cfg === "object" ? cfg : {};
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
 * Policy-aware URL check (F-07).
 *
 * Fails CLOSED (blocks) when a domain policy was configured
 * (`__openCoworkDomainConfigEnforced`) but the config payload
 * (`__openCoworkDomainConfig`) is missing/unavailable. This prevents a
 * silent allow-all bypass when the message that should have carried the
 * config lacked it.
 *
 * When no policy is enforced (the default), behavior is unchanged: an
 * empty/absent config means allow-all, exactly as before.
 */
export function checkUrlAllowedWithDomainConfig(url: string): UrlPolicyResult {
  if (isDomainConfigMissingButEnforced()) {
    return {
      allowed: false,
      reason: "Domain policy is enforced but the config is unavailable — blocking to fail closed.",
    };
  }
  return checkUrlAllowed(url, getDomainConfig());
}
