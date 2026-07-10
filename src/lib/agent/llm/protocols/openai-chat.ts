/**
 * OpenAI Chat Completions protocol — implements the
 * `packages/llm/src/protocols/openai-chat.ts`.
 *
 * Implements the `/chat/completions` API format used by OpenAI, Azure,
 * OpenRouter, and many OpenAI-compatible providers.
 */

import { Protocol, type LLMRequest } from "../route/client";

const ADAPTER = "openai-chat";
export const DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const PATH = "/chat/completions";

/** A single content part within a multimodal OpenAI message. */
export type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };

export interface OpenAIChatBody {
  model: string;
  messages: Array<{ role: string; content: string | OpenAIContentPart[] }>;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream: boolean;
  stream_options?: { include_usage: boolean };
  response_format?:
    | { type: string }
    | {
        type: "json_schema";
        json_schema: {
          name: string;
          schema: Record<string, unknown>;
          strict: boolean;
        };
      };
  frequency_penalty?: number;
}

export interface OpenAIChatChunk {
  choices?: Array<{
    delta?: { content?: string; role?: string };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/**
 * Match a `<screenshot>data:image/...;base64,...</screenshot>` marker.
 * OpenAI/Azure/xAI/OpenRouter + every openai-compatible profile ships the
 * screenshot as literal prompt text (tens of thousands of extra tokens) unless
 * we extract it into a proper `image_url` content part, mirroring the logic
 * already implemented in `anthropic-messages.ts` / `gemini.ts`.
 */
const SCREENSHOT_PATTERN = /<screenshot>(data:image\/(png|jpeg|webp);base64,[^<]+)<\/screenshot>/;

/** Default max_tokens fallback when the caller doesn't set one. */
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Build the OpenAI Chat body from a common LLMRequest. Extracts `<screenshot>`
 * markers from user messages into multimodal `image_url` content parts so
 * vision-capable OpenAI-format providers receive a proper image block instead
 * of a giant base64 string in the prompt text.
 */
async function fromRequest(request: LLMRequest): Promise<OpenAIChatBody> {
  const messages = request.messages.map((m) => {
    if (m.role === "user") {
      const match = m.content.match(SCREENSHOT_PATTERN);
      if (match) {
        const textContent = m.content.replace(/<screenshot>[^<]+<\/screenshot>/g, "").trim();
        const parts: OpenAIContentPart[] = [];
        if (textContent) parts.push({ type: "text", text: textContent });
        parts.push({ type: "image_url", image_url: { url: match[1] } });
        return { role: m.role, content: parts };
      }
    }
    return { role: m.role, content: m.content };
  });
  const body: OpenAIChatBody = {
    model: request.model.id,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: request.generation?.temperature ?? 0,
  };
  // match Anthropic (4096) and Gemini (8192) by having a hardcoded
  // fallback so output length is governed for OpenAI-format providers too.
  body.max_tokens = request.generation?.maxTokens ?? DEFAULT_MAX_TOKENS;
  if (request.generation?.topP) body.top_p = request.generation.topP;
  if (request.schema) {
    // Serialize the Zod schema into a JSON Schema object and send it via
    // `response_format: { type: "json_schema", … }` so OpenAI-format providers
    // (OpenAI, Azure, xAI, OpenRouter, + openai-compatible) honor the contract
    // instead of discarding the schema (the old `json_object` form ignored it).
    // Reuses the same `z.toJSONSchema` import pattern as the Anthropic/Gemini
    // protocols. The `name` ("response") is a fixed alphanumeric identifier as
    // required by the OpenAI structured-output API.
    let jsonSchema: unknown = request.schema;
    try {
      const zNS = (await import("zod")).z as unknown as { toJSONSchema?: (s: unknown) => unknown };
      if (typeof zNS.toJSONSchema === "function") {
        jsonSchema = zNS.toJSONSchema(request.schema);
      }
    } catch { /* fall back to raw schema if z.toJSONSchema unavailable */ }
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: "response",
        schema: jsonSchema as Record<string, unknown>,
        strict: true,
      },
    };
  }
  return body;
}

/** State for the stream reducer. */
export interface StreamState {
  content: string;
  finishReason: string | null;
  usage?: {
    tokensIn: number;
    tokensOut: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
    model: string;
    costUsd: number;
  };
}

export const protocol: Protocol<OpenAIChatBody, string, { type: string; content?: string; usage?: StreamState["usage"] }, StreamState> = {
  id: ADAPTER,
  body: {
    from: fromRequest,
  },
  stream: {
    initial: (_request: LLMRequest): StreamState => ({
      content: "",
      finishReason: null,
    }),
    step: (state: StreamState, frame: string) => {
      const events: Array<{ type: string; content?: string; usage?: StreamState["usage"] }> = [];
      if (frame === "[DONE]") {
        events.push({
          type: "finish",
          usage: state.usage,
        });
        return { state, events };
      }
      try {
        const chunk: OpenAIChatChunk = JSON.parse(frame);
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) {
          state.content += delta.content;
          events.push({ type: "text", content: delta.content });
        }
        const finish = chunk.choices?.[0]?.finish_reason;
        if (finish) {
          state.finishReason = finish;
        }
        if (chunk.usage) {
          const reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0;
          const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
          state.usage = {
            tokensIn: chunk.usage.prompt_tokens ?? 0,
            tokensOut: chunk.usage.completion_tokens ?? 0,
            reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
            cachedInputTokens: cachedTokens > 0 ? cachedTokens : undefined,
            model: "",
            costUsd: 0,
          };
        }
      } catch {
        // Non-JSON frame — skip
      }
      return { state, events };
    },
    terminal: (frame: string): boolean => {
      // OpenAI sends `usage` in a SEPARATE chunk AFTER `finish_reason`
      // (with empty `choices: []`), and then a final `[DONE]` sentinel. The
      // previous implementation returned `true` on a non-null `finish_reason`,
      // which terminated the stream loop BEFORE the usage chunk arrived —
      // silently dropping cost/token accounting on every OpenAI-format
      // provider (OpenAI, Azure, xAI, OpenRouter, + 10 openai-compatible
      // profiles).
      //
      // The `step()` reducer above already handles `[DONE]` by emitting a
      // `finish` event carrying `state.usage` (which was populated by the
      // preceding usage chunk). Returning `true` ONLY on `[DONE]` lets the
      // loop continue reading the usage chunk so cost tracking works.
      //
      // The earlier streaming-truncation regression is preserved: every
      // delta chunk still carries `finish_reason: null`, which is neither
      // `[DONE]` nor a non-null value, so `terminal()` returns `false` for it.
      if (frame === "[DONE]") return true;
      return false;
    },
  },
};

export * as OpenAIChat from "./openai-chat";
