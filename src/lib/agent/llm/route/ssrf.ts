/**
 * SSRF guard for LLM `baseUrl` values.
 *
 * The Chrome extension's service worker fetches the user's configured LLM
 * endpoint directly (no localhost backend). If a `baseUrl` is attacker-controlled
 * — e.g. via prompt injection that writes `chrome.storage.local`, a malicious
 * settings sync, or a crafted custom-tool payload — the service worker could be
 * made to reach:
 * - cloud metadata services (`http://169.254.169.254/` — AWS/GCP/Azure), which
 * live in link-local `169.254.0.0/16` (and IPv6 `fe80:/10`).
 *
 * This module provides a synchronous, DNS-free validator that rejects the
 * dangerous address ranges. It is wired into:
 * 1. `src/extension/provider-config.ts` — user-supplied `baseUrl`,
 * 2. `src/lib/agent/llm/providers/openai-compatible-profile.ts` — user-supplied
 * `baseURL` when synthesizing a profile,
 * 3. `src/lib/agent/llm/route/transport-http.ts` — defense-in-depth, on the
 * final fetch URL.
 *
 * Implementation is split across four focused modules:
 * - `ssrf-constants.ts` — types, curated-local-provider constants
 * - `ssrf-ipv6.ts` — IPv4/IPv6 literal classification
 * - `ssrf-dns.ts` — DNS resolution and hostname helpers
 * - `ssrf-validate.ts` — URL validation (LLM baseUrl, webhook)
 */

export type { SsrfProvenance } from "./ssrf-constants";
export { isCuratedLocalOrigin } from "./ssrf-constants";
export {
  validateLlmBaseUrl,
  resolveAndValidateLlmBaseUrl,
  isAllowedLlmBaseUrl,
  validateWebhookUrl,
  resolveAndValidateWebhookUrl,
} from "./ssrf-validate";
