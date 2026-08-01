/** Domain configuration shape returned by {@link getDomainConfig}. */
export interface DomainConfig {
  allowedDomains?: string[];
  blockedDomains?: string[];
}

/**
 * Stable, shared reference for the "no policy / invalid policy" case. Returning
 * a single canonical object keeps `getDomainConfig` references identity-stable
 * across calls (so `toBe` assertions hold) while still meaning "allow-all".
 */
export const EMPTY_CONFIG: DomainConfig = Object.freeze({});

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
 * Freeze a validated config in place (and its domain arrays) so callers cannot
 * mutate the shared/authoritative policy object. Guards against accidental
 * corruption of enforcement state (e.g. `cfg.allowedDomains.push(...)` on the
 * returned reference, or an in-page scenario that mutates the global policy).
 * Freezing is idempotent and does NOT change object identity, so `toBe`
 * assertions and cached references still hold.
 */
export function freezeConfigInPlace(cfg: DomainConfig): DomainConfig {
  if (!Object.isFrozen(cfg)) {
    if (cfg.allowedDomains) Object.freeze(cfg.allowedDomains);
    if (cfg.blockedDomains) Object.freeze(cfg.blockedDomains);
    Object.freeze(cfg);
  }
  return cfg;
}
