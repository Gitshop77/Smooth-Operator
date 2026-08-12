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

/** DNS callbacks are not cancellable, so never wait forever for one. */
export const DNS_RESOLVE_TIMEOUT_MS = 5_000;

export interface DnsResolveOptions {
  /** Root run signal. Aborting rejects promptly even if Chrome DNS is stalled. */
  signal?: AbortSignal;
  /** Testable timeout override; clamped to keep the resolver bounded. */
  timeoutMs?: number;
}

export type DnsResolverCapability = "available" | "permission-missing" | "api-unavailable";

/**
 * Report the packaged resolver capability truthfully. `chrome.dns` is a
 * Dev-channel API: a namespace alone is insufficient unless the current
 * extension manifest also declares the permission. Non-extension test hosts
 * have no manifest and may provide an explicit resolver adapter directly.
 */
export function dnsResolverCapability(): DnsResolverCapability {
  const chromeApi = (globalThis as {
    chrome?: {
      dns?: { resolve?: unknown };
      runtime?: { getManifest?: () => { permissions?: string[] } };
    };
  }).chrome;
  if (typeof chromeApi?.dns?.resolve !== "function") return "api-unavailable";
  if (typeof chromeApi.runtime?.getManifest === "function") {
    const permissions = chromeApi.runtime.getManifest().permissions;
    if (!Array.isArray(permissions) || !permissions.includes("dns")) return "permission-missing";
  }
  return "available";
}

function abortError(signal?: AbortSignal): DOMException {
  return signal?.reason instanceof DOMException
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}

/**
 * Resolve a hostname to its IP addresses using whatever DNS API is available.
 * Never returns null — it distinguishes "no resolver" from "resolver error".
 */
export async function dnsResolve(
  hostname: string,
  options: DnsResolveOptions = {},
): Promise<DnsOutcome> {
  type ResolveInfo = { address?: string; addresses?: string[]; resultCode?: number };
  type ResolveFunction = (
    host: string,
    callback?: (result: ResolveInfo) => void,
  ) => void | Promise<ResolveInfo>;
  const chromeApi = (globalThis as {
    chrome?: {
      dns?: { resolve?: ResolveFunction };
      runtime?: { lastError?: unknown };
    };
  }).chrome;
  const dnsResolveFn = chromeApi?.dns?.resolve;
  if (dnsResolveFn && dnsResolverCapability() === "available") {
    if (options.signal?.aborted) throw abortError(options.signal);
    const timeoutMs = Math.max(100, Math.min(DNS_RESOLVE_TIMEOUT_MS, options.timeoutMs ?? DNS_RESOLVE_TIMEOUT_MS));
    return await new Promise<DnsOutcome>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => finish(abortError(options.signal));
      const timer = setTimeout(() => finish({ kind: "error" }), timeoutMs);
      const finish = (result: DnsOutcome | DOMException): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        if (result instanceof DOMException && result.name === "AbortError") reject(result);
        else resolve(result as DnsOutcome);
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const consume = (result: ResolveInfo): void => {
          if (chromeApi?.runtime?.lastError ||
              (typeof result?.resultCode === "number" && result.resultCode !== 0)) {
            finish({ kind: "error" });
            return;
          }
          const ips = Array.isArray(result?.addresses)
            ? result.addresses
            : typeof result?.address === "string" && result.address.length > 0
              ? [result.address]
              : [];
          finish({ kind: "resolved", ips });
        };
        const pending = dnsResolveFn(hostname, consume);
        if (pending && typeof pending.then === "function") {
          void pending.then(consume, () => finish({ kind: "error" }));
        }
      } catch {
        finish({ kind: "error" });
      }
    });
  }
  return { kind: "unavailable" };
}
