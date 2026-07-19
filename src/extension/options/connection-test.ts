/**
 * options/connection-test.ts — provider-aware connection validation.
 *
 * Replaces the old "Test connection" which fired `buildProvider(...).chat(...)`
 * with a sampled model. That approach tested a *model*, not connectivity: a
 * perfectly valid key on a healthy provider would still 404 if the resolved
 * model id was wrong (e.g. OpenRouter's `anthropic/claude-3.5-sonnet` uses
 * DOTS — a hyphenated spelling 404s), producing a misleading "connection failed".
 *
 * The new approach lists the provider's *models* (or, for providers without a
 * reliable models endpoint, does a minimal key-presence probe). A models-list
 * proves the key is valid AND correctly scoped for that provider, so the
 * message can report how many models the key can see.
 *
 * Endpoint choice per provider (and why):
 *
 *  - OpenAI + every OpenAI-compatible family (openrouter, together, mistral,
 *    deepseek, groq, cerebras, qwen, opencode, litellm, xai, and Google Vertex
 *    which is reached through its user-supplied OpenAI-compatible `baseUrl`):
 *    `GET {resolvedBaseURL}/models` with `Authorization: Bearer <key>`. This is
 *    the OpenAI REST contract that all of these gateways implement; a 200 with
 *    a model list is the canonical "key works" signal.
 *
 *  - Azure OpenAI: `GET {base}/openai/deployments?api-version=2024-02-15-preview`
 *    with `api-key: <key>` (fall back to `Bearer`). We prefer the *deployments*
 *    endpoint over the generic `/openai/models` list because deployments are
 *    exactly what the key can actually call on that resource — `/openai/models`
 *    lists the base capability models, not what's deployed. If the deployments
 *    endpoint is unavailable we fall back to `/openai/models`. Azure's auth
 *    header is `api-key` (not `Authorization: Bearer`), documented as such.
 *
 *  - Anthropic: `GET https://api.anthropic.com/v1/models` with `x-api-key` +
 *    `anthropic-version: 2023-06-01`. (Anthropic has no `/v1/models` Bearer
 *    form; the dedicated headers are required.)
 *
 *  - Gemini: `GET https://generativelanguage.googleapis.com/v1beta/models?key=<key>`.
 *    The key rides the query string (Gemini's API design), so we don't log it
 *    and the SSRF guard ignores the query when classifying the host.
 *
 *  - Ollama (local, no key): `GET http://localhost:11434/api/tags`. Success =
 *    the local server is reachable. (We also accept `/api/models`.)
 *
 * SSRF: the extension grants `host_permissions: ["<all_urls>"]`, so fetching a
 * user-configured endpoint is permitted. We still run the project's existing
 * `resolveAndValidateLlmBaseUrl` guard (the same primitive `buildProvider`
 * uses) with the `user-configured` provenance so a malicious/loopback-misbound
 * baseUrl is rejected before any request leaves — this reuses the established
 * pattern rather than introducing a new SSRF bypass.
 *
 * Secret redaction: every error message passes through `redactKeyLeak`
 * (`@/extension/shared`) and also has the raw key substring stripped before it
 * is returned to the UI, so an error like `401: Invalid API key: sk-ant-…`
 * never surfaces the secret.
 */

import { redactKeyLeak } from "@/extension/shared";
import { PROVIDER_META } from "./providers";
import {
  resolveAndValidateLlmBaseUrl,
  validateLlmBaseUrl,
} from "../../lib/agent/llm/route/ssrf";

/** The result of a provider connection test. */
export interface ConnectionTestResult {
  /** Whether the connection (and, where applicable, the key) is valid. */
  ok: boolean;
  /** Round-trip latency in milliseconds (from call start to response). */
  latencyMs: number;
  /** Number of models the key can see, when the endpoint reports a list. */
  modelCount?: number;
  /** Human-readable, already-redacted message (≤240 chars on failure). */
  message: string;
}

/** Inputs for {@link testProviderConnection}. */
export interface ConnectionTestConfig {
  /** Provider id (openai, anthropic, gemini, ollama, azure, …). */
  provider: string;
  /** API key (Bearer / x-api-key / api-key). Omitted for Ollama. */
  apiKey: string;
  /** Base URL for OpenAI-compatible providers / Azure. Optional. */
  baseUrl?: string;
  /** Azure resource name (used to build the default Azure base URL). */
  resourceName?: string;
}

/**
 * Default base URLs for the OpenAI-compatible families. Only consulted when the
 * user hasn't supplied a `baseUrl`. This is NEW code (not a copy of the
 * `providers.ts` / `openai-compatible-profile.ts` defaults) so it stays in sync
 * with what `buildProvider` resolves to for these ids — but it's intentionally
 * a small, self-contained map rather than an import, to avoid coupling the test
 * path to the provider-facade build logic owned by other agents.
 */
const OPENAI_COMPAT_DEFAULT_BASE: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  together: "https://api.together.xyz/v1",
  mistral: "https://api.mistral.ai/v1",
  deepseek: "https://api.deepseek.com/v1",
  groq: "https://api.groq.com/openai/v1",
  cerebras: "https://api.cerebras.ai/v1",
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  opencode: "https://opencode.ai/zen/v1",
  litellm: "http://localhost:4000/v1",
  xai: "https://api.x.ai/v1",
  // "google" (Vertex AI) has NO default — the user must supply `baseUrl`, so it
  // is intentionally absent here.
};

/** Azure OpenAI API version used for the deployments/models listing. */
const AZURE_API_VERSION = "2024-02-15-preview";

/**
 * Canonical host an INJECTED/user baseUrl may target for a given provider
 * (mirrors `buildProvider`'s `canonicalLlmHost`). A public baseUrl must match
 * the provider's own host so the user's API key (sent as `Bearer`) can't be
 * exfiltrated to an attacker-controlled endpoint. Tail (catalog-derived)
 * providers have no known canonical host → `null` (no confinement), exactly
 * matching `buildProvider`. Local/loopback hosts are governed by the SSRF
 * guard below, not by host confinement.
 */
function canonicalHost(provider: string): { host: string; suffix?: boolean } | null {
  const fromBase = OPENAI_COMPAT_DEFAULT_BASE[provider];
  if (fromBase) return { host: new URL(fromBase).host };
  switch (provider) {
    case "openai": return { host: "api.openai.com" };
    case "anthropic": return { host: "api.anthropic.com" };
    case "gemini": return { host: "generativelanguage.googleapis.com" };
    case "google": return { host: "ai.googleapis.com" };
    case "azure": return { host: ".openai.azure.com", suffix: true };
    default:
      // Tail / catalog-derived providers (e.g. OpenCode, or any dataset provider
      // with a catalog `api` endpoint) have a known default base URL in
      // PROVIDER_META. Confine their baseUrl to that host so the key can't be
      // exfiltrated to an attacker-controlled host. Returning null here is only
      // for truly-unknown providers (ollama/litellm are handled separately by
      // the SSRF guard + loopback exemption), preserving the existing contract.
      {
        const metaUrl = PROVIDER_META[provider]?.defaultBaseUrl;
        if (metaUrl) {
          try {
            return { host: new URL(metaUrl).host };
          } catch {
            return null;
          }
        }
      }
      return null;
  }
}

/**
 * Returns an error message if `url` is a PUBLIC, keyed endpoint that does NOT
 * target the provider's canonical host (key-exfiltration guard). Returns `null`
 * when confinement does not apply (no key, local/loopback endpoint, or an
 * unknown/tail provider). Mirrors `buildProvider`'s canonical-host confinement.
 */
function checkCanonicalHost(provider: string, url: string, apiKey: string): string | null {
  if (!apiKey) return null;
  const canon = canonicalHost(provider);
  if (canon === null) return null;
  let host = "";
  try { host = new URL(url).host; } catch { return null; }
  // Local/loopback endpoints are exempt (legitimate Ollama/LiteLLM) and handled
  // by the SSRF guard instead.
  if (!validateLlmBaseUrl(url, false).ok) return null;
  const allowed = canon.suffix ? host.endsWith(canon.host) : host === canon.host;
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
function parseModelCount(payload: unknown): number | undefined {
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
function redact(message: string, apiKey: string): string {
  let out = redactKeyLeak(message);
  if (apiKey && apiKey.length >= 8) {
    out = out.split(apiKey).join("[REDACTED]");
  }
  return out.slice(0, 240);
}

/** Run the project's SSRF guard on a fetch URL (user-configured provenance). */
async function assertSsrfSafe(url: string): Promise<void> {
  const res = await resolveAndValidateLlmBaseUrl(url, true, "user-configured");
  if (!res.ok) {
    // `reason` already avoids leaking the key host; surface it as-is.
    throw new Error(res.reason || "URL rejected by SSRF guard");
  }
}

/**
 * Perform one authenticated `GET` to `url` and return the parsed JSON body.
 * Throws on network error or a non-2xx status (with a redacted, status-aware
 * message). The caller owns latency measurement + redaction of `apiKey`.
 */
async function getJson(url: string, headers: Record<string, string>, apiKey: string): Promise<unknown> {
  // `redirect: "manual"` mirrors transport-http.ts: a malicious baseUrl that
  // answers a 30x would otherwise forward the Bearer/api-key to an attacker
  // host (e.g. 169.254.169.254 / 127.0.0.1). We refuse to follow it instead of
  // leaking the key. The original url is still validated by assertSsrfSafe
  // before this fetch (see testProviderConnection).
  const res = await fetch(url, {
    method: "GET",
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  // `redirect: "manual"` returns an opaque-redirect response (type
  // "opaqueredirect", status 0, no body) when the server sends a 3xx. The key
  // was NOT forwarded. Throw rather than treat it as success / follow it.
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
 * Validate a provider connection by listing models (or probing key presence).
 *
 * @returns a {@link ConnectionTestResult} describing success/failure, latency,
 *          and (where available) the model count the key can see.
 */
export async function testProviderConnection(
  cfg: ConnectionTestConfig,
): Promise<ConnectionTestResult> {
  const { provider, apiKey, baseUrl, resourceName } = cfg;
  const start = Date.now();

  const fail = (message: string, modelCount?: number): ConnectionTestResult => ({
    ok: false,
    latencyMs: Date.now() - start,
    message: redact(message, apiKey),
    modelCount,
  });

  try {
    let url: string;
    let headers: Record<string, string> = {};
    let needsKey = true;
    let count: number | undefined;

    switch (provider) {
      case "anthropic": {
        url = "https://api.anthropic.com/v1/models";
        headers = { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
        // Canonical-host confinement (mirrors buildProvider) prevents the key
        // from being sent to a non-Anthropic host.
        const canonErr = checkCanonicalHost(provider, url, apiKey);
        if (canonErr) return fail(canonErr);
        break;
      }
      case "gemini": {
        // Key rides the query string (Gemini's design). No Authorization header.
        url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
        needsKey = false;
        break;
      }
      case "ollama": {
        url = "http://localhost:11434/api/tags";
        needsKey = false;
        break;
      }
      case "azure": {
        const base = baseUrl || (resourceName ? `https://${resourceName}.openai.azure.com` : "");
        if (!base) {
          return fail("Azure requires a baseUrl or resource name.");
        }
        const root = base.replace(/\/+$/, "");
        // Prefer deployments (what the key can actually call); fall back to the
        // generic models list if deployments is unavailable.
        const candidates: Array<{ url: string; headers: Record<string, string> }> = [
          { url: `${root}/openai/deployments?api-version=${AZURE_API_VERSION}`, headers: { "api-key": apiKey } },
          { url: `${root}/openai/models?api-version=${AZURE_API_VERSION}`, headers: { "api-key": apiKey } },
        ];
        let lastErr: unknown = null;
        for (const c of candidates) {
          try {
            // Canonical-host confinement (mirrors buildProvider): an Azure
            // baseUrl must resolve to *.openai.azure.com.
            const azCanon = checkCanonicalHost("azure", c.url, apiKey);
            if (azCanon) { lastErr = new Error(azCanon); continue; }
            await assertSsrfSafe(c.url);
            const body = await getJson(c.url, c.headers, apiKey);
            count = parseModelCount(body);
            const latency = Date.now() - start;
            return {
              ok: true,
              latencyMs: latency,
              modelCount: count,
              message: count !== undefined
                ? `Connected (${latency}ms, ${count} model${count === 1 ? "" : "s"} available)`
                : `Connected (${latency}ms)`,
            };
          } catch (e) {
            lastErr = e;
          }
        }
        return fail(lastErr instanceof Error ? lastErr.message : String(lastErr));
      }
      default: {
        // Accept ANY provider the Options dropdown can select (which now
        // includes every catalog provider with an `api` endpoint), not just a
        // hard-coded compat allow-list. `PROVIDER_META` maps the provider id to
        // its default base URL (the catalog `api` for dataset providers), so the
        // test exercises the exact endpoint `buildProvider` would use.
        if (!PROVIDER_META[provider]) {
          return fail(
            `Unknown provider "${provider}". Pick one from the provider list.`,
          );
        }
        const base =
          baseUrl ||
          PROVIDER_META[provider]?.defaultBaseUrl ||
          OPENAI_COMPAT_DEFAULT_BASE[provider] ||
          "";
        if (!base) {
          return fail(
            `Provider "${provider}" requires a baseUrl (no default endpoint).`,
          );
        }
        const root = base.replace(/\/+$/, "");
        url = `${root}/models`;
        headers = { Authorization: `Bearer ${apiKey}` };
        // A catalog-derived provider may declare needsKey=false (e.g. a local
        // or keyless gateway). Use the metadata rather than always requiring a
        // key, so a keyless provider isn't wrongly rejected.
        needsKey = PROVIDER_META[provider]?.needsKey ?? true;
        // Canonical-host confinement (mirrors buildProvider) prevents the key
        // from being exfiltrated to a non-canonical public host.
        const canonErr = checkCanonicalHost(provider, url, apiKey);
        if (canonErr) return fail(canonErr);
        break;
      }
    }

    if (needsKey && !apiKey) {
      return fail(`${providerLabel(provider)} requires an API key.`);
    }

    await assertSsrfSafe(url);
    const body = await getJson(url, headers, apiKey);
    count = parseModelCount(body);
    const latency = Date.now() - start;

    return {
      ok: true,
      latencyMs: latency,
      modelCount: count,
      message:
        count !== undefined
          ? `Connected (${latency}ms, ${count} model${count === 1 ? "" : "s"} available)`
          : `Connected (${latency}ms)`,
    };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Human label for a provider id in messages. Derived from `PROVIDER_META`
 * (which owns the canonical labels) so it can't drift from the dropdown.
 */
function providerLabel(provider: string): string {
  return PROVIDER_META[provider]?.label ?? provider;
}
