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

export const id = "google";

export type Config = { baseURL?: string } & ProviderAuthOption<"optional">;

const auth = (options: ProviderAuthOption<"optional">) => {
  if ("auth" in options && options.auth) return options.auth;
  return Auth.optional("apiKey" in options ? options.apiKey : undefined, "apiKey")
    .orElse(Auth.config("GOOGLE_GENERATIVE_AI_API_KEY"))
    .orElse(Auth.config("GEMINI_API_KEY"))
    .orElse(Auth.config("GOOGLE_API_KEY"))
    .pipe(Auth.header("x-goog-api-key"));
};

export function configure(input: Config = {}) {
  const baseURL = input.baseURL ?? Gemini.ENDPOINT;
  return {
    id,
    model: (modelID: string) => {
      // Per-model Route — Gemini puts the model in the URL path, not the body.
      // `alt=sse` is REQUIRED for the streaming endpoint: without it the API
      // returns a newline-delimited JSON-stream (one array per chunk) instead
      // of SSE `data: {...}\n\n` frames, which the `Framing.sse` parser can't
      // split into frames. The whole stream would be silently dropped.
      const route = make({
        id: "gemini",
        provider: id,
        protocol: Gemini.protocol,
        endpoint: Endpoint.path(Gemini.geminiPath(modelID), { baseURL, query: { alt: "sse" } }),
        auth: auth(input),
        framing: Framing.sse,
      });
      return route.model({ id: modelID });
    },
    configure,
  };
}

export const provider = configure();

/**
 * Bridge to the agent's `LLMProvider` interface. The protocol emits usage
 * with `model: ""` + `costUsd: 0`; we fill them in from the canonical
 * pricing table.
 */
export function toLLMProvider(config: Config & { model: string }): LLMProvider {
  return toLLMProviderBridge({
    providerId: "gemini",
    providerDisplayName: "Google",
    model: config.model,
    supportsVision: true,
    supportsStructuredOutput: true,
    configureResult: configure(config),
  });
}
