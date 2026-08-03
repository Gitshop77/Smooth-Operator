/**
 * Shared types, constants, and curated-local-origin helpers for the SSRF guard.
 */

export type SsrfCheckResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Origin provenance of an LLM `baseUrl`. Threaded through the SSRF validators so
 * the curated-local (loopback) exemption is granted ONLY for a `baseUrl` the
 * USER configured — never for one that arrived via an untrusted vector (prompt
 * injection writing `chrome.storage.local`, a malicious settings-sync payload, a
 * crafted tool call). When `provenance` is supplied it is AUTHORITATIVE over the
 * `allowLocalExemption` boolean; when absent the boolean keeps its historical
 * default (true) so existing callers stay behavior-compatible.
 */
export type SsrfProvenance = "user-configured" | "untrusted";

/**
 * Curated local-provider base URLs EXEMPT from the strict transport-layer SSRF
 * check. These are the exact default endpoints for Ollama and LiteLLM — both
 * reachable via `localhost`, `127.0.0.1`, and their IPv6 loopback spellings
 * (`::1`, the IPv4-mapped `::ffff:127.0.0.1`, and the deprecated IPv4-compatible
 * `::127.0.0.1`). Any OTHER loopback / RFC1918 URL — including those spellings
 * on non-default ports — is still rejected. The WHATWG URL parser canonicalizes
 * every embedded-IPv4 spelling to the same origin, so the exact-origin match in
 * `isCuratedLocalOrigin` covers all of them without extra parsing.
 */
export const LOCAL_PROVIDER_BASE_URLS: readonly string[] = [
  "http://localhost:11434",
  "http://127.0.0.1:11434",
  "http://localhost:4000",
  "http://127.0.0.1:4000",
  // IPv6 loopback spellings of the same two endpoints (default ports only).
  "http://[::1]:11434",
  "http://[::1]:4000",
  "http://[::ffff:127.0.0.1]:11434",
  "http://[::ffff:127.0.0.1]:4000",
  "http://[::127.0.0.1]:11434",
  "http://[::127.0.0.1]:4000",
];

/** Origins of the curated local providers (Ollama / LiteLLM), precomputed once. */
const CURATED_LOCAL_ORIGINS: ReadonlySet<string> = new Set(
  LOCAL_PROVIDER_BASE_URLS.flatMap((u) => {
    try {
      return [new URL(u).origin];
    } catch {
      return [];
    }
  }),
);

/** Internal TLD suffixes that should never be LLM endpoints. */
export const INTERNAL_TLD_SUFFIXES = [".internal", ".local", ".lan", ".home"];

/** True iff `url`'s origin exactly matches a curated local-provider endpoint. */
export function isCuratedLocalOrigin(url: string): boolean {
  try {
    return CURATED_LOCAL_ORIGINS.has(new URL(url).origin);
  } catch {
    return false;
  }
}
