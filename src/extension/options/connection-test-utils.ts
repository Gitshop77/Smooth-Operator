import { redactKeyLeak } from "@/extension/shared";
import { PROVIDER_META } from "./providers";
import {
  resolveAndValidateLlmBaseUrl,
  validateLlmBaseUrl,
} from "../../lib/agent/llm/route/ssrf";

/**
 * Default base URLs for the OpenAI-compatible families. Only consulted when the
 * user hasn't supplied a `baseUrl`. This is NEW code (not a copy of the
 * `providers.ts` / `openai-compatible-profile.ts` defaults) so it stays in sync
 * with what `buildProvider` resolves to for these ids — but it's intentionally
 * a small, self-contained map rather than an import, to avoid coupling the test
 * path to the provider-facade build logic owned by other agents.
 *
 * The map mirrors the runtime `profiles` table (`byProvider` in
 * `openai-compatible-profile.ts`) — every OpenAI-compatible family with a
 * static default host — so `canonicalHost` below stays in lockstep with
 * `buildProvider`'s `canonicalLlmHost`. The OpenCode entries are the API BASE
 * (`/chat/completions` is appended by the runtime facade). Loopback-only
 * profiles (ollama, litellm) are intentionally absent: local endpoints are
 * governed by the SSRF guard, not host confinement, on both sides.
 */
export const OPENAI_COMPAT_DEFAULT_BASE: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  together: "https://api.together.ai/v1",
  mistral: "https://api.mistral.ai/v1",
  deepseek: "https://api.deepseek.com",
  groq: "https://api.groq.com/openai/v1",
  cerebras: "https://api.cerebras.ai/v1",
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  opencode: "https://opencode.ai/zen/v1",
  "opencode-go": "https://opencode.ai/zen/go/v1",
  litellm: "http://localhost:4000/v1",
  xai: "https://api.x.ai/v1",
  // "google" (Vertex AI) has NO default — the user must supply `baseUrl`, so it
  // is intentionally absent here.
};

/** Azure OpenAI API version used for the deployments/models listing. */
export const AZURE_API_VERSION = "2024-02-15-preview";

/**
 * Canonical host an INJECTED/user baseUrl may target for a given provider
 * (mirrors `buildProvider`'s `canonicalLlmHost`). A public baseUrl must match
 * the provider's own host so the user's API key (sent as `Bearer`) can't be
 * exfiltrated to an attacker-controlled endpoint. Mirrors `canonicalLlmHost`
 * exactly:
 *  - `OPENAI_COMPAT_DEFAULT_BASE` mirrors the runtime `profiles` table
 *    (`byProvider`): every OpenAI-compatible family with a static default host;
 *  - the switch below mirrors `canonicalLlmHost`'s dedicated cases;
 *  - suffix entries allow the exact canonical host or a DOTTED subdomain
 *    boundary at the call site (`host === canon.host ||
 *    host.endsWith("." + canon.host)`), exactly like the runtime — allows
 *    `anthropic.com` / `proxy.anthropic.com` / any `{resource}.openai.azure.com`,
 *    rejects `evilanthropic.com` / `evilgoogleapis.com` which merely end with
 *    the canonical host;
 *  - tail (catalog-derived) providers → `null` (no confinement), exactly like
 *    `canonicalLlmHost`'s `default` branch. The options-side check must NOT
 *    invent a canonical host from the catalog `api` URL: `buildProvider`
 *    returns `null` for these, so confining them here would pass configs the
 *    runtime rejects.
 * Local/loopback hosts are governed by the SSRF guard, not host confinement.
 */
function canonicalHost(provider: string): { host: string; suffix?: boolean } | null {
  const fromBase = OPENAI_COMPAT_DEFAULT_BASE[provider];
  if (fromBase) return { host: new URL(fromBase).host };
  switch (provider) {
    case "openai": return { host: "api.openai.com" };
    case "anthropic": return { host: "anthropic.com", suffix: true };
    case "gemini": return { host: "generativelanguage.googleapis.com" };
    case "google": return { host: "googleapis.com", suffix: true };
    case "azure": return { host: "openai.azure.com", suffix: true };
    default: return null;
  }
}

/**
 * Returns an error message if `url` is a PUBLIC, keyed endpoint that does NOT
 * target the provider's canonical host (key-exfiltration guard). Returns `null`
 * when confinement does not apply (no key, local/loopback endpoint, or an
 * unknown/tail provider). Mirrors `buildProvider`'s canonical-host confinement.
 */
export function checkCanonicalHost(provider: string, url: string, apiKey: string): string | null {
  if (!apiKey) return null;
  const canon = canonicalHost(provider);
  if (canon === null) return null;
  let host = "";
  try { host = new URL(url).host; } catch { return null; }
  if (!validateLlmBaseUrl(url, false).ok) return null;
  const allowed = canon.suffix
    ? host === canon.host || host.endsWith("." + canon.host)
    : host === canon.host;
  if (!allowed) {
    return `baseUrl must target the canonical host for provider "${provider}" to protect your API key from exfiltration.`;
  }
  return null;
}

/**
 * Parse a model count out of a provider's models-list response. Providers use
 * different envelope shapes, so we probe the common ones:
 *  - OpenAI-compatible / Azure: `{ data: [...] }`
 *  - Anthropic: `{ data: [...] }`
 *  - Gemini: `{ models: [...] }`
 *  - Ollama (tags): `{ models: [...] }`
 * Returns `undefined` when no recognizable list is present (we still report a
 * successful connection — we just can't cite a count).
 */
export function parseModelCount(payload: unknown): number | undefined {
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.data)) return obj.data.length;
    if (Array.isArray(obj.models)) return obj.models.length;
    if (Array.isArray(obj.results)) return obj.results.length;
  }
  return undefined;
}

/**
 * Redact the API key from a message and truncate to a UI-safe length.
 * We re-run `redactKeyLeak` AND strip the raw key substring so a secret that
 * appears anywhere in the (possibly unstructured) provider error is masked.
 */
export function redact(message: string, apiKey: string): string {
  let out = redactKeyLeak(message);
  if (apiKey) {
    out = out.split(apiKey).join("[REDACTED]");
  }
  return out.slice(0, 240);
}

/** Run the project's SSRF guard on a fetch URL (user-configured provenance). */
export async function assertSsrfSafe(url: string): Promise<void> {
  const res = await resolveAndValidateLlmBaseUrl(url, true, "user-configured");
  if (!res.ok) {
    throw new Error(res.reason || "URL rejected by SSRF guard");
  }
}

/**
 * Perform one authenticated `GET` to `url` and return the parsed JSON body.
 * Throws on network error or a non-2xx status (with a redacted, status-aware
 * message). The caller owns latency measurement + redaction of `apiKey`.
 */
export async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, {
    method: "GET",
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (res.type === "opaqueredirect") {
    throw new Error("redirect refused by Test Connection");
  }
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      if (body && typeof body === "object") {
        const b = body as Record<string, unknown>;
        detail = typeof b.error === "string"
          ? b.error
          : typeof b.message === "string"
            ? b.message
            : JSON.stringify(b).slice(0, 200);
      }
    } catch {
      try {
        detail = (await res.text()).slice(0, 200);
      } catch {
        detail = "";
      }
    }
    const suffix = detail ? `: ${detail}` : "";
    throw new Error(`HTTP ${res.status}${suffix}`);
  }
  try {
    return await res.json();
  } catch {
    return {};
  }
}

/**
 * Human label for a provider id in messages. Derived from `PROVIDER_META`
 * (which owns the canonical labels) so it can't drift from the dropdown.
 */
export function providerLabel(provider: string): string {
  return PROVIDER_META[provider]?.label ?? provider;
}