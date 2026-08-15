/**
 * LLM provider abstraction — the single interface every provider implements.
 * Decouples the agentic engine from any specific SDK so the same engine can
 * run with OpenAI, Anthropic, Gemini, or any OpenAI-compatible endpoint.
 */

import type { ImagePartV1 } from "./image-part";

/** A single chat message in the conversation. */
export interface ChatMessage {
  /** Message role: system, user, or assistant. */
  role: "system" | "user" | "assistant";
  /** Message content — plain text, or a parts array mixing text with
   * structured image parts (the navigator's screenshot attachment). */
  content: string | Array<string | ImagePartV1>;
}

/** Non-sensitive aggregate progress from an already-open provider stream. */
export interface LLMStreamProgress {
  outputChars: number;
  deltaChars: number;
  chunkCount: number;
  at: number;
}

/** Request payload for {@link LLMProvider.chat}. */
export interface LLMRequest {
  /** Conversation messages (system / user / assistant). */
  messages: ChatMessage[];
  /** Optional JSON schema for structured-output mode (provider may ignore). */
  schema?: unknown;
  /** Temperature override (provider default if omitted). */
  temperature?: number;
  /** Max tokens (provider default if omitted). */
  maxTokens?: number;
  /** Optional reasoning configuration: effort level, thinking budget in tokens,
   * and a force on/off switch. Protocols only act on it when the provider is a
   * reasoning model (`supportsReasoning`), so non-reasoning providers keep
   * today's exact request shape. */
  reasoning?: {
    /** Reasoning-effort level (e.g. "low" | "medium" | "high"). */
    effort?: string;
    /** Thinking budget in tokens (Anthropic `budget_tokens` / Gemini `thinkingBudget`). */
    budgetTokens?: number;
    /** Force reasoning params on (true) or off (false); unset = provider default. */
    enabled?: boolean;
  };
  /** True when the caller expects the same prompt to be reused across calls, so
   * prompt-cache markers are worth writing (Anthropic "1h" TTL). One-shot calls
   * leave this unset so protocols can omit cache markers entirely. */
  cacheEligible?: boolean;
  /** Optional abort signal, honored by the underlying fetch so a run's STOP/cancel
   * is respected mid-generation rather than only after the request completes. */
  signal?: AbortSignal;
  /** Reports aggregate stream movement only; never includes model text. */
  onProgress?: (progress: LLMStreamProgress) => void;
}

/** Token-usage + cost information returned by a provider. */
export interface LLMUsage {
  /** Prompt tokens consumed. */
  tokensIn: number;
  /** Completion tokens produced. */
  tokensOut: number;
  /** Reasoning/thinking tokens (billed separately for reasoning models). */
  reasoningTokens?: number;
  /** Cached input tokens (billed at a discount by providers that support
 * prompt caching — Anthropic cache_read + cache_creation, OpenAI cached_tokens). */
  cachedInputTokens?: number;
  /** Cache-write (creation) input tokens — Anthropic `cache_creation_input_tokens`.
  * Billed at the provider's (typically higher) cache-write rate, distinct from
  * `cachedInputTokens` (cache reads). */
  cachedWriteInputTokens?: number;
  /** Context (input) token count driving tiered-rate selection. When absent,
   * cost estimation falls back to `tokensIn` (input tokens are the context). */
  contextTokens?: number;
  /** Model name (provider-specific). */
  model: string;
  /** Cost in USD (best-effort; 0 if unknown). */
  costUsd: number;
}

/** Response payload from {@link LLMProvider.chat}. */
export interface LLMResponse {
  /** The completion text. */
  content: string;
  /** Optional usage/cost breakdown. */
  usage?: LLMUsage;
  /** Model id that produced the response (echoed even when usage is absent). */
  model?: string;
}

/** A streamed text chunk from a streaming chat completion. */
interface StreamChunk {
  /** Partial text content (may be empty for the final usage-only chunk). */
  content?: string;
  /** Final usage/cost (only present on the terminal chunk). */
  usage?: LLMUsage;
  /** True when this is the last chunk. */
  done?: boolean;
}

/** Common interface every LLM provider implements. */
export interface LLMProvider {
  /** Unique provider id (e.g. "ollama", "openai", "anthropic"). */
  readonly id: string;
  /** Human-readable display name. */
  readonly displayName: string;
  /** Whether this provider supports JSON-schema structured output natively. */
  readonly supportsStructuredOutput: boolean;
  /** Whether this provider can accept image inputs (vision). */
  readonly supportsVision: boolean;
  /** Whether the resolved model is a reasoning model (rejects `temperature`). */
  readonly supportsReasoning?: boolean;
  /** Perform a single chat completion. */
  chat(req: LLMRequest): Promise<LLMResponse>;
  /** Stream a chat completion, yielding text chunks as they arrive. */
  streamChat?(req: LLMRequest): AsyncIterable<StreamChunk>;
}
