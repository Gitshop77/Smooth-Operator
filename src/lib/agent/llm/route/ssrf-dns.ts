/**
 * DNS resolution and hostname helpers for the SSRF guard.
 */

// ─── Hostname helpers ────────────────────────────────────────────────────────

/** Extract just the hostname from a URL (no brackets, no port). */
export function baseUrlHost(url: string): string {
  const parsed = parseBaseUrl(url);
  return parsed ? parsed.hostname : "";
}

/** True for a DNS hostname (contains a dot or is not a pure IP literal). */
export function isLikelyHostname(host: string): boolean {
  if (host.includes(":")) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  return true;
}

/**
 * Parse a `baseUrl` into a {@link URL}, repairing a common IPv6-literal typo
 * where `::` was written as a single `:` inside the brackets.
 * Returns null for any URL that cannot be parsed even after the repair attempt.
 */
export function parseBaseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    const m = /^([^[\]]*)\[([^\]]+)\](.*)$/.exec(url);
    if (m) {
      const repairedHost = m[2].replace(/:(?!:)/, "::");
      try {
        return new URL(`${m[1]}[${repairedHost}]${m[3]}`);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Redact credentials and trailing query/fragment from a URL string before it
 * is embedded into a `reason`/`Error` message or log line.
 */
export { redactUrl } from "./url-redact";

// ─── DNS resolution ──────────────────────────────────────────────────────────

/**
 * Resolution outcome, distinguishing the three cases a DNS lookup can hit.
 */
type DnsOutcome =
  | { kind: "resolved"; ips: string[] }
  | { kind: "error" }
  | { kind: "unavailable" };

/**
 * Resolve a hostname to its IP addresses using whatever DNS API is available.
 * Never returns null — it distinguishes "no resolver" from "resolver error".
 */
export async function dnsResolve(hostname: string): Promise<DnsOutcome> {
  const dnsResolveFn = (globalThis as { chrome?: { dns?: { resolve?: (h: string, cb: (r: { addresses?: string[] }) => void) => void } } }).chrome?.dns?.resolve;
  if (dnsResolveFn) {
    return await new Promise<DnsOutcome>((resolve) => {
      try {
        dnsResolveFn(hostname, (result) => {
          if (chrome.runtime.lastError) {
            resolve({ kind: "error" });
            return;
          }
          resolve({ kind: "resolved", ips: result?.addresses ?? [] });
        });
      } catch {
        resolve({ kind: "error" });
      }
    });
  }
  return { kind: "unavailable" };
}
