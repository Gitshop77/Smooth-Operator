/**
 * OpenAI Chat Completions protocol — implements the
 * `packages/llm/src/protocols/openai-chat.ts`.
 *
 * Implements the `/chat/completions` API format used by OpenAI, Azure,
 * OpenRouter, and many OpenAI-compatible providers.
 */

import { Protocol, type LLMRequest } from "../route/client";
import { zodToJsonSchema } from "../zod-json-schema";
import { omitZero } from "../shared";
import { isImagePartV1 } from "../image-part";
import {
  isZodSchema,
  isPlainJSONSchema,
  extractScreenshots,
} from "../shared-image";
import {
  normalizeStrictSchema,
} from "./openai-chat-utils";

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
  /** Reasoning models (o-series / grok-reasoning) need this instead of `max_tokens`. */
  max_completion_tokens?: number;
  /** Reasoning-effort level for reasoning models (e.g. "low" | "medium" | "high"). */
  reasoning_effort?: string;
}

interface OpenAIChatChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      role?: string;
      /** OpenRouter/OpenAI-compatible reasoning variants. Never retained/logged. */
      reasoning?: unknown;
      reasoning_content?: unknown;
      reasoning_details?: unknown;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
    prompt_tokens_details?: { cached_tokens?: number };
  };
  /** Provider-reported error payload (OpenAI surfaces errors as JSON, not a thrown exception). */
  error?: { message?: string } | string;
}

/**
 * Match a `<screenshot>data:image/...;base64,...</screenshot>` marker.
 * OpenAI/Azure/xAI/OpenRouter + every openai-compatible profile ships the
 * screenshot as literal prompt text (tens of thousands of extra tokens) unless
 * we extract it into a proper `image_url` content part, mirroring the logic
 * already implemented in `anthropic-messages.ts` / `gemini.ts`.
 */

/** Default max_tokens fallback when the caller doesn't set one. */
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Build the OpenAI Chat body from a common LLMRequest. Extracts `<screenshot>`
 * markers from user messages into multimodal `image_url` content parts so
 * vision-capable OpenAI-format providers receive a proper image block instead
 * of a giant base64 string in the prompt text.
 */
async function fromRequest(request: LLMRequest): Promise<OpenAIChatBody> {
 // Validate the model id up front — `request.model.id` flows into the request
 // body unchecked, and a missing/garbage id produces an opaque provider 400.
 // Surface it clearly instead .
  if (!request.model || typeof request.model.id !== "string" || request.model.id.length === 0) {
    throw new Error("OpenAI-format request is missing a valid model id");
  }
  const messages = request.messages.map((m) => {
    if (m.role === "user") {
      // Structured image parts (the navigator's screenshot): emit image_url
      // parts directly and SKIP the regex scan — the base64 lives only in the
      // part, so a forged `<screenshot>` marker in text can never be promoted
      // into an image block.
      if (Array.isArray(m.content) && m.content.some(isImagePartV1)) {
        const parts: OpenAIContentPart[] = [];
        for (const part of m.content) {
          if (typeof part === "string") {
            if (part) parts.push({ type: "text", text: part });
          } else {
            parts.push({ type: "image_url", image_url: { url: part.dataUrl } });
          }
        }
        return { role: m.role, content: parts };
      }
      // Legacy STRING content: extract `<screenshot>` markers as defense-
      // in-depth for callers that still interpolate them into text. Parts
      // arrays without an image part flatten to text parts (never scanned).
      if (typeof m.content === "string") {
        const { text: textContent, dataUris } = extractScreenshots(m.content);
        if (dataUris.length > 0) {
          const parts: OpenAIContentPart[] = [];
          if (textContent) parts.push({ type: "text", text: textContent });
          for (const dataUri of dataUris) {
            parts.push({ type: "image_url", image_url: { url: dataUri } });
          }
          return { role: m.role, content: parts };
        }
        return { role: m.role, content: m.content };
      }
      const textParts: OpenAIContentPart[] = [];
      for (const part of m.content) {
        if (typeof part === "string" && part) textParts.push({ type: "text", text: part });
      }
      return { role: m.role, content: textParts };
    }
    // Non-user messages never carry image parts — flatten any parts array to
    // its text defensively.
    return {
      role: m.role,
      content: typeof m.content === "string"
        ? m.content
        : m.content.filter((part): part is string => typeof part === "string").join(""),
    };
  });
  const body: OpenAIChatBody = {
    model: request.model.id,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
 // Reasoning models (OpenAI o-series, Grok-reasoning) reject `temperature`
 // and require `max_completion_tokens` instead of `max_tokens`; sending the
 // unsupported params yields a provider 400. Gate on `request.reasoning`.
 // `enabled: false` (user forced reasoning off) suppresses the whole
 // reasoning branch and restores the non-reasoning params.
  if (request.reasoning && request.reasoningConfig?.enabled !== false) {
    body.max_completion_tokens = request.generation?.maxTokens ?? DEFAULT_MAX_TOKENS;
    if (request.reasoningConfig?.effort) body.reasoning_effort = request.reasoningConfig.effort;
  } else {
    body.temperature = request.generation?.temperature ?? 0;
 // match Anthropic (4096) and Gemini (8192) by having a hardcoded
 // fallback so output length is governed for OpenAI-format providers too.
    body.max_tokens = request.generation?.maxTokens ?? DEFAULT_MAX_TOKENS;
    if (request.generation?.topP) body.top_p = request.generation.topP;
  }
  if (request.schema) {
 // `structuredOutputStrict` defaults to true for the openai-chat protocol
 // (OpenAI/Azure/xAI/OpenRouter honor strict mode). OpenAI-compatible
 // providers that 400 on strict mode must pass `structuredOutputStrict:
 // false`, which falls back to `json_object` and lets the in-prompt schema
 // contract (llm-direct) carry the structure instead.
    const strict = request.structuredOutputStrict ?? true;
    if (strict) {
 // Serialize the Zod schema into a JSON Schema object and send it via
 // `response_format: { type: "json_schema", … }` so OpenAI-format providers
 // (OpenAI, Azure, xAI, OpenRouter, + openai-compatible) honor the contract
 // instead of discarding the schema (the old `json_object` form ignored it).
 // Reuses the same `z.toJSONSchema` import pattern as the Anthropic/Gemini
 // protocols. The `name` ("response") is a fixed alphanumeric identifier as
 // required by the OpenAI structured-output API.
 //
 // If `request.schema` is ALREADY a plain JSON Schema (e.g. `{ type:
 // "object" }` — the shape callers/tests pass), forward it as-is. Calling
 // `z.toJSONSchema` on a non-Zod object throws ("Cannot read properties of
 // undefined (reading 'def')"), which was a genuine regression. Only Zod
 // objects need conversion; we still THROW on any conversion failure so a
 // non-serializable schema surfaces clearly rather than being POSTed as a
 // raw Zod object (opaque provider `400`). We also normalize to OpenAI
 // "strict" mode requirements (`additionalProperties: false`, all properties
 // `required`, no `nullable`) so `strict: true` is honored consistently.
      let jsonSchema: unknown;
      if (isZodSchema(request.schema)) {
        jsonSchema = JSON.parse(JSON.stringify(await zodToJsonSchema(request.schema)));
      } else {
        jsonSchema = request.schema;
      }
      if (!isPlainJSONSchema(jsonSchema)) {
        throw new Error("Response schema did not produce a serializable JSON Schema object");
      }
      jsonSchema = normalizeStrictSchema(jsonSchema);
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: "response",
          schema: jsonSchema as Record<string, unknown>,
          strict: true,
        },
      };
    } else {
 // Non-strict providers: ask for JSON mode only and rely on the in-prompt
 // schema fallback (llm-direct) to convey the structure.
      body.response_format = { type: "json_object" };
    }
  }
  return body;
}

/** State for the stream reducer. */
export interface StreamState {
  content: string;
  /** Model id for usage attribution (carried from the request). */
  model?: string;
  /** Number of non-JSON SSE frames dropped (logged, not forwarded). */
  droppedFrames?: number;
  /** A provider emitted a reasoning-only field; content is deliberately not retained. */
  reasoningObserved?: boolean;
  /** Last provider terminal reason, retained as a safe machine-readable tag. */
  finishReason?: string;
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
    initial: (request: LLMRequest): StreamState => ({
      content: "",
      model: request.model.id,
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
 // Separate the two distinct failure modes:
 // 1. A non-JSON frame (truncated stream / proxy artifact) — log it and
 // skip, consistent with `anthropic-messages.ts`.
 // 2. A provider error payload (`{"error": {...}}`) — valid JSON, so it
 // parses fine, but it must NOT be swallowed: we throw so the route
 // propagates it instead of returning empty output that masks
 // auth/quota/permission failures.
      let chunk: OpenAIChatChunk;
      try {
        chunk = JSON.parse(frame);
      } catch {
 // Log only the byte length — the raw frame can carry model output or
 // scraped page content (PII, secrets) that must not leak into logs.
        const dropped = (state.droppedFrames ?? 0) + 1;
        state.droppedFrames = dropped;
 // If we already streamed real content, a dropped frame mid-stream means
 // the assistant output may be silently truncated. Surface a non-PII
 // warning (frame contents are NOT logged) so the truncation is
 // observable rather than invisible .
        if (state.content.length > 0) {
          console.warn(
            `[openai-chat] Dropped non-JSON SSE frame (${frame.length} bytes) after ${state.content.length} chars of content were already streamed — output may be truncated (${dropped} frame(s) dropped total).`
          );
        } else {
          console.warn(`[openai-chat] Dropping non-JSON SSE frame (${frame.length} bytes)`);
        }
        return { state, events };
      }
      if (chunk.error) {
        const err = chunk.error;
        const msg = typeof err === "string" ? err : (err.message ?? JSON.stringify(err));
        throw new Error(`OpenAI API error: ${msg}`);
      }
      const delta = chunk.choices?.[0]?.delta;
      if (
        delta &&
        ("reasoning" in delta || "reasoning_content" in delta || "reasoning_details" in delta)
      ) {
        // Reasoning text can contain sensitive model/page-derived material.
        // Record only its presence so the route can distinguish a reasoning-only
        // completion from an ordinary empty answer.
        state.reasoningObserved = true;
      }
      if (delta?.content) {
        state.content += delta.content;
        events.push({ type: "text", content: delta.content });
      }
      const finishReason = chunk.choices?.[0]?.finish_reason;
      if (finishReason) state.finishReason = finishReason;
      if (chunk.usage) {
        const reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0;
        const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
        state.usage = {
          tokensIn: chunk.usage.prompt_tokens ?? 0,
          tokensOut: chunk.usage.completion_tokens ?? 0,
          reasoningTokens: omitZero(reasoningTokens),
          cachedInputTokens: omitZero(cachedTokens),
          model: state.model ?? "",
          costUsd: 0,
        };
      }
      return { state, events };
    },
    terminal: (frame: string, state?: StreamState): boolean => {
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
 // Some OpenAI-compatible servers (observed with llama.cpp) occasionally
 // finish generation and emit the final usage chunk but leave the SSE body
 // open without a literal `[DONE]`. At that point there can be no more answer
 // text: a non-null finish_reason has already arrived and the post-finish
 // usage record is present. Treat that pair as equivalent terminal evidence
 // so the client cancels the idle reader instead of waiting for the long local
 // stream-stall timeout. This retains usage accounting while remaining later
 // than the old, unsafe "finish_reason alone" early-exit behavior.
 //
 // The earlier streaming-truncation regression is preserved: every
 // delta chunk still carries `finish_reason: null`, which is neither
 // `[DONE]` nor a non-null value, so `terminal()` returns `false` for it.
      if (frame === "[DONE]") return true;
      return state?.finishReason !== undefined && state.usage !== undefined;
    },
    completion: (state: StreamState) => ({
      reasoningObserved: state.reasoningObserved,
      reasoningTokens: state.usage?.reasoningTokens,
      finishReason: state.finishReason,
      droppedFrames: state.droppedFrames,
    }),
  },
};
