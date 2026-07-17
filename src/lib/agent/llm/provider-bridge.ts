/**
 * Shared `toLLMProvider` bridge — eliminates the ~25-line duplication across
 * all 7 provider facades.
 *
 * Each facade calls this with its configured `configure()` output + provider
 * metadata (id prefix, display name, vision support). The bridge returns a
 * standard `LLMProvider` instance that runs `generate()` per chat call and
 * re-computes usage/cost from the live catalog-backed pricing module.
 *
 * NOTE: this module lives at `src/lib/agent/llm/provider-bridge.ts` (a sibling
 * of `provider.ts` / `pricing.ts` / the `route/` directory) — NOT inside
 * `providers/` — so its relative imports use `./provider`, `./pricing`, and
 * `./route/client`. The 7 facades import it as `../provider-bridge`.
 */
import { estimateCost } from "./pricing";
import { omitZero } from "./shared";
import type { LLMProvider, LLMRequest, LLMResponse } from "./provider";

export interface ProviderBridgeConfig {
  /** Provider id prefix (e.g. "openai", "anthropic"). Combined with model name for the LLMProvider id. */
  providerId: string;
  /** Human-readable provider name (e.g. "OpenAI", "Anthropic"). */
  providerDisplayName: string;
  /** Model name to send in the request body. */
  model: string;
  /** Whether this provider supports image inputs (vision). */
  supportsVision: boolean;
  /**
   * Whether the resolved model is a reasoning model (rejects `temperature`
   * / `frequency_penalty`, expects `max_completion_tokens`). Forwarded to the
   * route-layer `LLMRequest.reasoning` so the protocol omits those params.
   */
  supportsReasoning?: boolean;
  /**
   * Whether to request OpenAI "strict" JSON-schema structured output.
   * Forwarded to `LLMRequest.structuredOutputStrict`. OpenAI-compatible
   * providers that 400 on strict mode should leave this unset (defaulting to
   * non-strict `json_object` + in-prompt schema fallback).
   */
  structuredOutputStrict?: boolean;
  /**
 * Whether this provider supports JSON-schema structured output natively.
 *
 * Per-provider (not hardcoded `true`), so the in-prompt schema fallback at
 * `llm-direct.ts:176-178,238-250` actually fires. Local providers (Ollama,
 * LiteLLM) and some OpenAI-compatible endpoints don't reliably honor
 * `response_format: { type: "json_schema", … }` — for those, the fallback
 * inlines the canonical JSON schema into the system prompt so the model
 * has a concrete contract to emit. Cloud providers (OpenAI, Anthropic,
 * Gemini, Groq, Together, …) set this `true`.
 */
  supportsStructuredOutput: boolean;
  /** The configured provider's `configure()` output — must have a `.model(id)` method. */
  configureResult: {
    model: (modelID: string) => unknown;
  };
}

/**
 * Build an `LLMProvider` from a configured provider facade.
 *
 * Returns an `LLMProvider` whose `chat()` method:
 * - Builds a model handle via `configureResult.model(model)`.
 * - Dynamically imports `generate` from `./route/client` (preserves the
 * existing lazy-import pattern).
 * - Re-computes `usage.costUsd` from the live catalog-backed pricing module (the
 * protocol returns `costUsd: 0`; we override it here).
 */
export function toLLMProvider(config: ProviderBridgeConfig): LLMProvider {
  return {
    id: `${config.providerId}:${config.model}`,
    displayName: `${config.providerDisplayName} ${config.model}`,
    supportsStructuredOutput: config.supportsStructuredOutput,
    supportsVision: config.supportsVision,
    supportsReasoning: config.supportsReasoning ?? false,
 // NOTE: bridged providers implement `chat` only. `streamChat` is intentionally
 // NOT provided — it is optional on the `LLMProvider` interface, and no streaming
 // entry point exists in the route layer that the bridge could delegate to. Any
 // consumer needing streaming must null-check `provider.streamChat` before calling
 // it; invoking it unguarded on a bridged provider would be a contract violation.
    async chat(req: LLMRequest): Promise<LLMResponse> {
      const model = config.configureResult.model(config.model);
      const { generate } = await import("./route/client");
 // Route registration is a side effect of importing the provider's route
 // definitions. If the model's route was never imported in this execution
 // context, `generate` throws a "No route registered" error. We re-throw it
 // attributed to this bridged provider so the failure is diagnosable here
 // rather than surfacing far from its cause as a generic provider/auth problem.
      let response: Awaited<ReturnType<typeof generate>>;
      try {
        response = await generate(
          {
            model: model as Parameters<typeof generate>[0]["model"],
            messages: req.messages,
            generation: {
              ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
              ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
            },
            schema: req.schema,
            ...(config.supportsReasoning ? { reasoning: true } : {}),
            ...(config.structuredOutputStrict ? { structuredOutputStrict: true } : {}),
          },
          req.signal,
        );
      } catch (err) {
        if (err instanceof Error && err.message.includes("No route registered")) {
          throw new Error(
            `Bridged provider "${config.providerId}" failed to generate: ${err.message} ` +
              `(ensure the provider module that builds this model's route is imported in this execution context before calling chat)`,
          );
        }
        throw err;
      }
      const tokensIn = response.usage?.tokensIn ?? 0;
      const tokensOut = response.usage?.tokensOut ?? 0;
      const reasoningTokens = response.usage?.reasoningTokens ?? 0;
      const cachedInputTokens = response.usage?.cachedInputTokens ?? 0;
      const cachedWriteInputTokens = response.usage?.cachedWriteInputTokens ?? 0;
      return {
        content: response.content,
        usage: response.usage
          ? {
              tokensIn,
              tokensOut,
              reasoningTokens: omitZero(reasoningTokens),
              cachedInputTokens: omitZero(cachedInputTokens),
              cachedWriteInputTokens: omitZero(cachedWriteInputTokens),
              model: config.model,
              costUsd: estimateCost(config.model, tokensIn, tokensOut, reasoningTokens, cachedInputTokens, cachedWriteInputTokens, undefined, config.providerId),
            }
          : undefined,
      };
    },
  };
}
