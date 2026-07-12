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
const SCREENSHOT_PATTERN = /<screenshot>(data:image\/(png|jpeg|webp);base64,[^<]+)<\/screenshot>/g;

/** Default max_tokens fallback when the caller doesn't set one. */
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Validate that a string is well-formed base64 (no whitespace, correct
 * padding, only the legal alphabet). Used to reject malformed `<screenshot>`
 * markers locally instead of forwarding them to the provider for an opaque
 * `400`. Mirrors the `isValidBase64` guard in `anthropic-messages.ts`.
 */
function isValidBase64(s: string): boolean {
  // Reject empty / whitespace / illegal-alphabet payloads locally instead of
  // forwarding them to the provider for an opaque 400. We intentionally do NOT
  // enforce a strict length-multiple-of-4 rule: a trailing `=` padding string
  // like `iVBOR==` is a perfectly usable image payload, and over-strict length
  // gating was a regression that rejected valid screenshots.
  return s.length > 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(s);
}

/**
 * A converted JSON Schema must be a plain object, never a raw Zod schema
 * object. Zod v4 schema objects expose `safeParse` (and a `~standard`
 * symbol), so we reject those to avoid forwarding an un-serializable object.
 */
function isPlainJSONSchema(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.safeParse === "function") return false;
  if ("~standard" in o) return false;
  return true;
}

/** Heuristic: is this a Zod schema object (vs. an already-plain JSON Schema)? */
function isZodSchema(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (("safeParse" in value && typeof (value as { safeParse?: unknown }).safeParse === "function") ||
      "_def" in value)
  );
}

/**
 * Normalize a JSON Schema to OpenAI "strict" requirements so providers that
 * enforce `strict: true` (OpenAI, Azure, xAI, OpenRouter, + compatible) don't
 * reject it with a `400`:
 *   - every object schema gets `additionalProperties: false`;
 *   - every property is listed in `required`;
 *   - `nullable: true` is rewritten to `anyOf: [<schema>, { type: "null" }]`
 *     (OpenAI strict mode forbids the `nullable` keyword).
 *
 * Recursion is depth-bounded to stay cheap on large schemas.
 */
function normalizeStrictSchema(node: unknown, depth = 0): unknown {
  if (depth > 24 || typeof node !== "object" || node === null) return node;
  const obj: Record<string, unknown> = { ...(node as Record<string, unknown>) };

  if (obj.nullable === true) {
    delete obj.nullable;
    const baseType = obj.type as string | string[] | undefined;
    const nonNullType = Array.isArray(baseType) ? baseType : (baseType ?? "string");
    obj.anyOf = [{ ...obj, type: nonNullType }, { type: "null" }];
    delete obj.type;
  }

  if (obj.type === "object" && obj.properties && typeof obj.properties === "object") {
    const props = obj.properties as Record<string, unknown>;
    obj.additionalProperties = false;
    const required = Array.isArray(obj.required) ? [...(obj.required as string[])] : [];
    for (const key of Object.keys(props)) {
      if (!required.includes(key)) required.push(key);
    }
    obj.required = required;
  }

  for (const key of ["properties", "items", "anyOf", "allOf", "oneOf", "not"]) {
    const child = obj[key];
    if (Array.isArray(child)) obj[key] = child.map((c) => normalizeStrictSchema(c, depth + 1));
    else if (child && typeof child === "object") obj[key] = normalizeStrictSchema(child, depth + 1);
  }
  return obj;
}

/**
 * Build the OpenAI Chat body from a common LLMRequest. Extracts `<screenshot>`
 * markers from user messages into multimodal `image_url` content parts so
 * vision-capable OpenAI-format providers receive a proper image block instead
 * of a giant base64 string in the prompt text.
 */
async function fromRequest(request: LLMRequest): Promise<OpenAIChatBody> {
  const messages = request.messages.map((m) => {
    if (m.role === "user") {
      // Extract EVERY screenshot marker (not just the first) into its own
      // `image_url` content part — a multi-screenshot turn must forward all
      // of them, matching the Anthropic protocol.
      const matches = Array.from(m.content.matchAll(SCREENSHOT_PATTERN));
      if (matches.length > 0) {
        const textContent = m.content.replace(/<screenshot>[^<]+<\/screenshot>/g, "").trim();
        const parts: OpenAIContentPart[] = [];
        if (textContent) parts.push({ type: "text", text: textContent });
        for (const match of matches) {
          const dataUri = match[1];
          const b64 = dataUri.split(",")[1];
          if (!isValidBase64(b64 ?? "")) {
            throw new Error("Invalid base64 screenshot payload in user message");
          }
          parts.push({ type: "image_url", image_url: { url: dataUri } });
        }
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
      try {
        const zNS = (await import("zod")).z as unknown as { toJSONSchema?: (s: unknown) => unknown };
        if (typeof zNS.toJSONSchema === "function") {
          jsonSchema = zNS.toJSONSchema(request.schema);
        } else {
          throw new Error("z.toJSONSchema is unavailable in this Zod version");
        }
      } catch (e) {
        throw new Error(
          `Failed to convert response schema to JSON Schema: ${e instanceof Error ? e.message : String(e)}`
        );
      }
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
      // Separate the two distinct failure modes:
      //   1. A non-JSON frame (truncated stream / proxy artifact) — log it and
      //      skip, consistent with `anthropic-messages.ts`.
      //   2. A provider error payload (`{"error": {...}}`) — valid JSON, so it
      //      parses fine, but it must NOT be swallowed: we throw so the route
      //      propagates it instead of returning empty output that masks
      //      auth/quota/permission failures.
      let chunk: OpenAIChatChunk;
      try {
        chunk = JSON.parse(frame);
      } catch {
        console.warn(`[openai-chat] Dropping non-JSON SSE frame: ${frame.slice(0, 200)}`);
        return { state, events };
      }
      const chunkAny = chunk as unknown as { error?: { message?: string } | string };
      if (chunkAny.error) {
        const err = chunkAny.error;
        const msg = typeof err === "string" ? err : (err.message ?? JSON.stringify(err));
        throw new Error(`OpenAI API error: ${msg}`);
      }
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
