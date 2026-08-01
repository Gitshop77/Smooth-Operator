/**
 * Google Gemini provider facade — uses the gemini protocol against
 * `https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent`
 * with `x-goog-api-key` header auth.
 *
 * The path is dynamic per model (the model name goes in the URL, not the
 * request body), so `configure().model(id)` builds a fresh Route per model
 * with the model-specific path.
 *
 * Auth chain: explicit `apiKey` → `GOOGLE_GENERATIVE_AI_API_KEY` env var →
 * `GEMINI_API_KEY` env var → `GOOGLE_API_KEY` env var → throw.
 */

import { Auth, type ProviderAuthOption } from "../route/auth";
import { Endpoint } from "../route/endpoint";
import { Framing } from "../route/framing";
import { make } from "../route/client";
import * as Gemini from "../protocols/gemini";
import type { LLMProvider } from "../provider";
import { toLLMProvider as toLLMProviderBridge } from "../provider-bridge";
import { assertSafeUserBaseURL } from "./openai-compatible-profile";
import { isCuratedLocalOrigin, type SsrfProvenance } from "../route/ssrf";

const id = "google";

type Config = {
  baseURL?: string;
  // When true (user-configured provenance) the curated-local-provider loopback
  // exemption MAY be honored — but only for a baseURL that exactly matches a
  // curated local origin (Ollama / LiteLLM). For any other baseURL the SSRF
  // guard stays strict, so this is NOT a blanket toggle that relaxes the guard
  // for every provider.
  allowLocalExemption?: boolean;
} & ProviderAuthOption<"optional">;

const auth = (options: ProviderAuthOption<"optional">) => {
  if ("auth" in options && options.auth) return options.auth;
  return Auth.optional(options.apiKey, "apiKey")
    .orElse(Auth.config("GOOGLE_GENERATIVE_AI_API_KEY"))
    .orElse(Auth.config("GEMINI_API_KEY"))
    .orElse(Auth.config("GOOGLE_API_KEY"))
    .pipe(Auth.header("x-goog-api-key"));
};

export function configure(input: Config = {}) {
  // (SSRF guard): validate any user-supplied baseURL override before
  // building the route/endpoint. The trusted default (Gemini.ENDPOINT) is
  // exempt. The curated-local-provider loopback exemption is honored ONLY when
  // the baseURL exactly matches a curated local origin (Ollama / LiteLLM) AND
  // the user opted in; it is NOT a blanket toggle, so an arbitrary
  // (non-curated) loopback / RFC1918 baseUrl is always rejected by the guard
  // (mirrors the openai.ts facade).
  const exemption = !!input.allowLocalExemption && !!input.baseURL && isCuratedLocalOrigin(input.baseURL);
  assertSafeUserBaseURL(input.baseURL, id, exemption);
  const baseURL = input.baseURL ?? Gemini.ENDPOINT;
 // These depend only on the fixed `baseURL`/`input` captured by `configure`,
 // so compute them once instead of re-parsing the URL and rebuilding the auth
 // pipeline on every `model()` call.
  const parsed = new URL(baseURL);
  const basePath = parsed.pathname.replace(/\/+$/, "");
  const builtAuth = auth(input);
  // Derive SSRF provenance from allowLocalExemption: when the user explicitly
  // configured this provider (allowLocalExemption=true), provenance is
  // "user-configured"; otherwise "untrusted". This ensures the async DNS
  // validation in transport-http.ts uses the correct trust level.
  const provenance: SsrfProvenance = input.allowLocalExemption ? "user-configured" : "untrusted";
  return {
    id,
    model: (modelID: string) => {
 // Per-model Route — Gemini puts the model in the URL path, not the body.
 // `alt=sse` is REQUIRED for the streaming endpoint: without it the API
 // returns a newline-delimited JSON-stream (one array per chunk) instead
 // of SSE `data: {...}\n\n` frames, which the `Framing.sse` parser can't
 // split into frames. The whole stream would be silently dropped.
 //
 // The route's `buildURL` resolves the path with `new URL(path, base)`. A
 // leading-slash `geminiPath` (`/{model}:streamGenerateContent`) would
 // REPLACE the whole base path per the URL spec, silently dropping the
 // `/v1beta/models` prefix baked into `Gemini.ENDPOINT` (and any path a
 // user-supplied `baseURL` carries). To preserve it, split the base into
 // origin + path prefix and prepend the prefix to the per-model path, so
 // the final URL is `<origin>/v1beta/models/{model}:streamGenerateContent`.
      const fullPath = `${basePath}${Gemini.geminiPath(modelID)}`;
      const route = make({
        // Fold the model id into the route id so distinct models register under
        // distinct registry keys and a later model() call can't clobber the
        // earlier model's route (per-model paths differ).
        id: `gemini:${modelID}`,
        provider: id,
        protocol: Gemini.protocol,
        endpoint: Endpoint.path(fullPath, { baseURL: parsed.origin, query: { alt: "sse" } }),
        auth: builtAuth,
        framing: Framing.sse,
        provenance,
      });
      return route.model({ id: modelID });
    },
    configure,
  };
}

/**
 * Bridge to the agent's `LLMProvider` interface. The protocol emits usage
 * with `model: ""` + `costUsd: 0`; we fill them in from the canonical
 * pricing module.
 */
export function toLLMProvider(config: Config & { model: string }): LLMProvider {
  return toLLMProviderBridge({
 // Keep `providerId` consistent with this module's `id` ("google") and the
 // route's `provider` field, so telemetry / cost / catalog keys line up.
    providerId: "google",
    providerDisplayName: "Google",
    model: config.model,
 // `supportsVision` defaults to `true`; the authoritative per-model value is
 // patched by the catalog layer (`buildProvider`) after default resolution, so
 // a model id absent from the catalog is reported as vision-capable. The catalog
 // is the single source of truth and must cover every Gemini model this facade
 // can serve (legacy models without vision are corrected there, mirroring the
 // Anthropic facade's coarse gate).
    supportsVision: true,
    supportsStructuredOutput: true,
    configureResult: configure(config),
  });
}
