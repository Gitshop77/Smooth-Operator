/**
 * Shared test helper for the `evaluate`/`executeAction` domain allowlist stub.
 *
 * `evaluate` fails closed unless the current origin is on an explicit domain
 * allowlist (`__openCoworkDomainConfig`). These helpers install/remove the
 * global so individual tests don't each re-type the same `globalThis` dance,
 * reducing the risk that a copy-paste edit silently drops the fail-closed
 * guarantee.
 */

const DOMAIN_CONFIG_KEY = "__openCoworkDomainConfig";

/** Allowlist a single host (IP literal or hostname) for the evaluate sandbox. */
export function allowDomain(host: string): void {
  (globalThis as Record<string, unknown>)[DOMAIN_CONFIG_KEY] = {
    allowedDomains: [host],
  };
}

/** Remove the allowlist so the next test starts from a clean (fail-closed) slate. */
export function clearDomainAllowlist(): void {
  delete (globalThis as Record<string, unknown>)[DOMAIN_CONFIG_KEY];
}
