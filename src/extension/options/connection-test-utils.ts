import { redactKeyLeak } from "@/extension/shared";
import { PROVIDER_META } from "./providers";
import { profiles } from "../../lib/agent/llm/providers/openai-compatible-profile";
import {
  resolveAndValidateLlmBaseUrl,
  validateLlmBaseUrl,
} from "../../lib/agent/llm/route/ssrf";

/**
 * Default base URLs for the OpenAI-compatible families. Only consulted when the
 * user hasn't supplied a `baseUrl`.
 *
 * The map is DERIVED from the runtime `profiles` table (`byProvider` in
 * `openai-compatible-profile.ts`) — the source `buildProvider`'s
 * `canonicalLlmHost` reads — plus the dedicated `openai` case (which has no
 * profile entry). Deriving instead of hand-maintaining keeps the two sides in
 * lockstep: a provider added to the profiles table is confined here
 * automatically (baseten, deepinfra, fireworks, …), and loopback-only profiles
 * (ollama, litellm) get their canonical hosts too, exactly like the runtime.
 */
export const OPENAI_COMPAT_DEFAULT_BASE: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  ...Object.fromEntries(
    Object.values(profiles).map((p) => [p.provider, p.baseURL]),
  ),
};

/** Azure OpenAI API version used for the deployments/models listing. */
export const AZURE_API_VERSION = "2024-02-15-preview";

/**
 * Canonical host an INJECTED/user baseUrl may target for a given provider
 * (mirrors `buildProvider`'s `canonicalLlmHost`). A public baseUrl must match
 * the provider's own host so the user's API key (sent as `Bearer`) can't be
 * exfiltrated to an attacker-controlled endpoint. Mirrors `canonicalLlmHost`
 * exactly:
 *  - `OPENAI_COMPAT_DEFAULT_BASE` is derived from the runtime `profiles` table
 *    (`byProvider`): every OpenAI-compatible family with a static default host;
 *  - the switch below mirrors `canonicalLlmHost`'s dedicated cases;
 *  - suffix entries allow the exact canonical host or a DOTTED subdomain
 *    boundary at the call site (`host === canon.host ||
 *    host.endsWith("." + canon.host)`), exactly like the runtime — allows
 *    `anthropic.com` / `proxy.anthropic.com` / any `{resource}.openai.azure.com`,
 *    rejects `evilanthropic.com` / `evilgoogleapis.com` which merely end with
 *    the canonical host;
 *  - tail (catalog-derived) providers → `null`, exactly like `canonicalLlmHost`'s
 *    `default` branch. `checkCanonicalHost` treats `null` as a REJECT, mirroring
 *    the runtime's `allowed = canon !== null && …` — the options side must NOT
 *    invent a canonical host from the catalog `api` URL, and must not pass a
 *    config the runtime refuses.
 * Local/loopback hosts are governed by the SSRF guard, not host confinement.
 */
function canonicalHost(provider: string): { host: string; suffix?: boolean } | null {
  const fromBase = OPENAI_COMPAT_DEFAULT_BASE[provider];
  if (fromBase) return { host: new URL(fromBase).host };
  switch (provider) {
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
 * when confinement does not apply (no key, local/loopback endpoint, or a URL
 * the SSRF guard already rejects). Mirrors `buildProvider`'s canonical-host
 * confinement: like the runtime, a provider with NO canonical host rejects any
 * non-local keyed baseUrl (the runtime computes `allowed = canon !== null &&
 * …`, so `null` means reject).
 */
export function checkCanonicalHost(provider: string, url: string, apiKey: string): string | null {
  if (!apiKey) return null;
  const canon = canonicalHost(provider);
  let hostname = "";
  try { hostname = new URL(url).hostname; } catch { return null; }
  if (!validateLlmBaseUrl(url, false).ok) return null;
  const denied = () =>
    `baseUrl must target the canonical host for provider "${provider}" to protect your API key from exfiltration.`;
  if (canon === null) return denied();
  const allowed = canon.suffix
    ? hostname === canon.host || hostname.endsWith("." + canon.host)
    : hostname === canon.host;
  if (!allowed) return denied();
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