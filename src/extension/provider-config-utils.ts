import { profiles, byProvider } from "../lib/agent/llm/providers/openai-compatible-profile";

/**
 * Default base URLs — derived from the canonical profiles table.
 *
 * NOTE: `DEFAULT_BASE_URLS` is ONLY consulted by:
 * - the `default` (OpenAI-compatible) branch in `buildProvider`, which
 * synthesizes a profile for providers without a dedicated `case`
 * (deepseek, qwen, groq, ollama, ...);
 * - the dedicated `case "google"` branch (Vertex AI), which requires an
 * explicit `baseUrl` from the user and THROWS if none is supplied (it does
 * NOT fall back to this map; `google` is intentionally absent here, matching
 * the `google`/Vertex facade which has no static default URL).
 *
 * Providers that have their OWN dedicated `case` AND a static default in their
 * facade (`openai`, `anthropic`, `gemini`, `xai`, `openrouter`, `azure`) never
 * read this map. So we deliberately exclude `openrouter` / `xai` from the
 * spread below (they'd be dead entries that look like they back the dedicated
 * cases but don't). `google` is intentionally NOT in the profiles table, so
 * it is absent here and the `case "google"` branch requires an explicit
 * `baseUrl` from the user .
 */
export const DEFAULT_BASE_URLS: Record<string, string> = {
  // Spread the profiles table entries (covers deepseek, groq, together, etc.)
  // — excluding `openrouter` / `xai`, which have dedicated `case` branches and
  // therefore never consult this map. Providers with a dedicated `case`
  // (`openai`, `anthropic`, `gemini`, `xai`, `openrouter`, `azure`) are NOT
  // listed here on purpose: their default base URLs come from the provider
  // facades, so a dead entry here would be misleading and a regression risk if
  // a dedicated `case` ever regressed to the `default` branch. `google` is
  // handled separately by its own `case` branch and is intentionally absent
  // from this spread.
  ...Object.fromEntries(
    Object.values(profiles)
      .filter((p) => p.provider !== "openrouter" && p.provider !== "xai")
      .map((p) => [p.provider, p.baseURL]),
  ),
};

/** Default models for each provider (used when the user doesn't specify one).
 * These are OFFLINE FALLBACK ONLY — the online default model is resolved from
 * the models.dev catalog via `getDefaultModelForProvider` (see `buildProvider`).
 * They don't appear in the profiles table because they change frequently.
 *
 * Exported so `agent-bridge.ts` can apply the SAME default-model resolution
 * when computing `mainModelVision` — otherwise an empty `model` field would
 * disagree with the LLM-side check in `navigatorCallDirect()` (which uses
 * `provider.supportsVision` AFTER default resolution in `buildProvider`).
 * That disagreement caused the screenshot gating to flip-flop: extractState
 * thought "no vision" and skipped `captureVisibleTab`, while navigatorCallDirect
 * thought "vision" and tried to embed a non-existent screenshot. */
// NOTE: keys are CATALOG provider ids (not UI provider ids), because
// `buildProvider` resolves the model via the catalog id (see CATALOG_PROVIDER_ID_MAP).
// e.g. qwen -> "alibaba", together -> "togetherai", gemini/google -> "google",
// azure -> "openai". gemini & azure have NO separate key here — they resolve through
// the "google" / "openai" keys above.
export const DEFAULT_MODELS: Record<string, string> = {
  openai:    "gpt-5.5",
  anthropic: "claude-sonnet-5",
  google:    "gemini-3.5-flash",
  deepseek:  "deepseek-v4-flash",
  alibaba: "qwen3.7-max",
  groq:      "llama-3.3-70b-versatile",
  togetherai:"meta-llama/Llama-3.3-70B-Instruct-Turbo",
  mistral:   "mistral-small-latest",
  cerebras:  "gpt-oss-120b",
  openrouter:"anthropic/claude-sonnet-5",
  ollama:    "llama3.3",
  opencode:  "",
  litellm:   "gpt-5.5",
  xai:       "grok-4.3",
};

/**
 * Per-family default-model priorities, consulted by the catalog default
 * resolution (`getDefaultModelForProvider`) BEFORE its newest-stable fallback.
 *
 * Keys are CATALOG provider ids (the same namespace as `DEFAULT_MODELS`). Each
 * list names the preferred model families for that provider in order; the
 * first STABLE member present in the live catalog wins. This keeps defaults
 * family-aware for providers with no curated `DEFAULT_MODELS` entry (e.g. the
 * catalog-derived long tail) and expresses the flagship family preference
 * without hardcoding a point release. Experimental (alpha/beta) entries are
 * skipped so a default never silently selects an opt-in model.
 */
export const defaultModelPriority: Record<string, string[]> = {
  // Prefer the flagship GPT-5.x family over the newest point release.
  openai: ["gpt-5.4", "gpt-5.2"],
  anthropic: ["claude-sonnet-5", "claude-opus-5"],
  google: ["gemini-3.5-flash", "gemini-3-pro"],
  // Kimi's k2.x line is the battle-tested family; kimi-k3 is the newest.
  moonshotai: ["kimi-k2.5", "kimi-k2.6"],
};

/**
 * Canonical host(s) an INJECTED provider config's `baseUrl` is allowed to point
 * at. An injected (untrusted) config must not be able to redirect the user's
 * API key (sent as a Bearer token) to an attacker-controlled public endpoint,
 * so the forwarded baseUrl is confined to the provider's own host. Returns null
 * when the provider has no well-known canonical host — callers then reject any
 * injected `baseUrl` (fail safe). For providers marked `suffix: true`, a
 * DOTTED subdomain boundary is required at the call site (`host === canon.host`
 * or `host.endsWith("." + canon.host)`) — this allows `proxy.anthropic.com`
 * but rejects `evil-anthropic.com`, which merely ends with the canonical host.
 *
 * Azure is special-cased: any Azure account can claim `{name}.openai.azure.com`,
 * so the per-resource suffix allowance is granted ONLY for a user-configured
 * `baseUrl` (`provenance === "user"`). An injected azure config must match the
 * exact canonical host — which is not a real endpoint — and therefore fails
 * closed.
 */
export function canonicalLlmHost(
  provider: string,
  provenance: "user" | "injected" = "user",
): { host: string; suffix?: boolean } | null {
  const prof = byProvider[provider];
  if (prof) return { host: new URL(prof.baseURL).host };
  switch (provider) {
    case "openai": return { host: "api.openai.com" };
    case "anthropic": return { host: "anthropic.com", suffix: true };
    case "gemini": return { host: "generativelanguage.googleapis.com" };
    case "google": return { host: "googleapis.com", suffix: true };
    case "azure": return { host: "openai.azure.com", suffix: provenance === "user" };
    default: return null;
  }
}

/** Positive check: true if `url` targets a local endpoint (loopback, RFC1918, or localhost). */
export function isLocalUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (h === "localhost" || h.endsWith(".localhost")) return true;
    if (h.includes(":")) {
      // IPv6 — simplified check for loopback (::1) and ULA (fc00::/7)
      return h === "::1" || h === "0:0:0:0:0:0:0:1" || h.startsWith("fc") || h.startsWith("fd");
    }
    // IPv4 — loopback, RFC1918, and CGNAT/Tailscale (100.64.0.0/10).
    const parts = h.split(".");
    if (parts.length !== 4) return false;
    const a = Number(parts[0]);
    const b = Number(parts[1]);
    if (a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  } catch {
    return false;
  }
}
