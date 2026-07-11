/**
 * LLM provider abstraction — the single interface every provider implements.
 * Decouples the agentic engine from any specific SDK so the same engine can
 * run with OpenAI, Anthropic, Gemini, or any OpenAI-compatible endpoint.
 */

/** A single chat message in the conversation. */
export interface ChatMessage {
  /** Message role: system, user, or assistant. */
  role: "system" | "user" | "assistant";
  /** Message content (text). */
  content: string;
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
   *  prompt caching — Anthropic cache_read + cache_creation, OpenAI cached_tokens). */
  cachedInputTokens?: number;
  /** Cache-write (creation) input tokens — Anthropic `cache_creation_input_tokens`.
   *  Billed at the provider's (typically higher) cache-write rate, distinct from
   *  `cachedInputTokens` (cache reads). */
  cachedWriteInputTokens?: number;
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
}

/** A streamed text chunk from a streaming chat completion. */
export interface StreamChunk {
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
  /** Perform a single chat completion. */
  chat(req: LLMRequest): Promise<LLMResponse>;
  /** Stream a chat completion, yielding text chunks as they arrive. */
  streamChat?(req: LLMRequest): AsyncIterable<StreamChunk>;
}
