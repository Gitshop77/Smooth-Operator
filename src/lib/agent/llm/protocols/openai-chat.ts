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
import {
  SCREENSHOT_PATTERN_G,
  hasImageProvenance,
  isValidBase64,
  isZodSchema,
} from "../shared-image";

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

/**
 * Normalize a JSON Schema to OpenAI "strict" requirements so providers that
 * enforce `strict: true` (OpenAI, Azure, xAI, OpenRouter, + compatible) don't
 * reject it with a `400`:
 * - every object schema gets `additionalProperties: false`;
 * - every property is listed in `required`;
 * - `nullable: true` is rewritten to `anyOf: [<schema>, { type: "null" }]`
 * (OpenAI strict mode forbids the `nullable` keyword).
 *
 * Recursion is depth-bounded to stay cheap on large schemas.
 */
function normalizeStrictSchema(node: unknown, depth = 0): unknown {
  if (typeof node !== "object" || node === null) return node;
 // A `$ref` points at a definition we can't resolve here (no schema catalog
 // at this layer) — leave it untouched rather than dropping it, which would
 // lose the reference. Previously `$ref`/`$defs` were not descended into, so
 // referenced subschemas escaped normalization (FULL-REVIEW finding 63).
  const refObj = node as Record<string, unknown>;
 // A `{ nullable: true, $ref: "..." }` node must be normalized BEFORE the
 // `$ref` early-return below, otherwise the forbidden `nullable` keyword
 // survives and OpenAI strict mode rejects the request with a 400. Rewrite it
 // to a strict-compliant `anyOf` union of the reference and a `null` branch,
 // dropping `nullable` (the `$ref` still points at the unresolved definition).
  if (refObj.nullable === true && "$ref" in refObj) {
    return { anyOf: [{ $ref: refObj["$ref"] }, { type: "null" }] };
  }
  if ("$ref" in refObj) return node;
  const obj: Record<string, unknown> = { ...refObj };

 // 1. Object schemas: enforce `additionalProperties: false` + full `required`
 // FIRST, so a later nullable wrap captures an already-strict object.
  if (obj.type === "object" && obj.properties && typeof obj.properties === "object") {
    const props = obj.properties as Record<string, unknown>;
    obj.additionalProperties = false;
    const required = Array.isArray(obj.required) ? [...(obj.required as string[])] : [];
    for (const key of Object.keys(props)) {
      if (!required.includes(key)) required.push(key);
    }
    obj.required = required;
  }

 // 2. Nullable: rewrite to `anyOf: [<non-null branch>, { type: "null" }]`.
 // The non-null branch is the (already-normalized) object above, so it is
 // strict-compliant (additionalProperties:false + required). Previously the
 // branch was built AFTER the object block had been skipped (type deleted),
 // producing a non-strict `anyOf` that OpenAI strict mode rejects
 // (FULL-REVIEW finding 64).
  if (obj.nullable === true) {
    delete obj.nullable;
    const baseType = obj.type as string | string[] | undefined;
    const nonNullType = Array.isArray(baseType) ? baseType : (baseType ?? "string");
    obj.anyOf = [{ ...obj, type: nonNullType }, { type: "null" }];
    delete obj.type;
   // The non-null branch (anyOf[0]) already carries these via the spread
   // above; leaving them as siblings of `anyOf` violates OpenAI strict-mode
   // schema rules (object keywords alongside a union keyword).
    delete obj.properties;
    delete obj.additionalProperties;
    delete obj.required;
  }

 // 3. Recurse into child schemas.
 // Bound only the descent, not the local object fixup above: even at the
 // depth boundary the object normalization must still apply so deeply-nested
 // object schemas remain strict-compliant (additionalProperties:false +
 // full `required`) and don't trigger an OpenAI strict-mode 400.
  if (depth >= 24) return obj;
  for (const key of ["items", "anyOf", "allOf", "oneOf", "not"]) {
    const child = obj[key];
    if (Array.isArray(child)) obj[key] = child.map((c) => normalizeStrictSchema(c, depth + 1));
    else if (child && typeof child === "object") obj[key] = normalizeStrictSchema(child, depth + 1);
  }
 // `properties` and `$defs` are dicts of name→subschema. Descend into each
 // *value* so nested object properties and referenced definitions also get
 // strict-normalized (additionalProperties:false + full required). Treating
 // either dict as a single node was a no-op — a nested OBJECT property never
 // received additionalProperties:false + required, so OpenAI strict mode
 // rejected it with a 400.
  for (const key of ["properties", "$defs"]) {
    const child = obj[key];
    if (child && typeof child === "object" && !Array.isArray(child)) {
      const dict = child as Record<string, unknown>;
      obj[key] = Object.fromEntries(
        Object.entries(dict).map(([k, v]) => [k, normalizeStrictSchema(v, depth + 1)]),
      );
    }
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
 // Validate the model id up front — `request.model.id` flows into the request
 // body unchecked, and a missing/garbage id produces an opaque provider 400.
 // Surface it clearly instead (FULL-REVIEW finding 98).
  if (!request.model || typeof request.model.id !== "string" || request.model.id.length === 0) {
    throw new Error("OpenAI-format request is missing a valid model id");
  }
  const messages = request.messages.map((m) => {
    if (m.role === "user") {
 // Extract EVERY screenshot marker (not just the first) into its own
 // `image_url` content part — a multi-screenshot turn must forward all
 // of them, matching the Anthropic protocol.
      const matches = Array.from(m.content.matchAll(SCREENSHOT_PATTERN_G));
      if (matches.length > 0) {
 // Strip with the SAME pattern we match on, so the text we keep always
 // agrees with the screenshots we extract (the previous literal regex
 // `[^<]+` would also strip non-image `<screenshot>...</screenshot>`
 // markers — FULL-REVIEW finding 65).
        const textContent = m.content.replace(SCREENSHOT_PATTERN_G, "").trim();
        const parts: OpenAIContentPart[] = [];
        if (textContent) parts.push({ type: "text", text: textContent });
        for (const match of matches) {
          const dataUri = match[1];
          const b64 = dataUri.split(",")[1];
          if (!isValidBase64(b64 ?? "")) {
            throw new Error("Invalid base64 screenshot payload in user message");
          }
 // Provenance: reject markers whose payload does not actually decode to
 // an image of the declared type (see hasImageProvenance). Prevents
 // injected <screenshot> markers in scraped/tool content from
 // forwarding attacker-chosen bytes to the model as an image block.
          if (!hasImageProvenance(b64 ?? "", match[2])) {
            throw new Error("<screenshot> marker failed provenance check: base64 payload does not match its declared image type.");
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
  };
 // Reasoning models (OpenAI o-series, Grok-reasoning) reject `temperature`
 // and require `max_completion_tokens` instead of `max_tokens`; sending the
 // unsupported params yields a provider 400. Gate on `request.reasoning`.
  if (request.reasoning) {
    body.max_completion_tokens = request.generation?.maxTokens ?? DEFAULT_MAX_TOKENS;
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
        jsonSchema = await zodToJsonSchema(request.schema);
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
  finishReason: string | null;
  /** Model id for usage attribution (carried from the request). */
  model?: string;
  /** Number of non-JSON SSE frames dropped (logged, not forwarded). */
  droppedFrames?: number;
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
      finishReason: null,
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
 // observable rather than invisible (FULL-REVIEW finding 5 / 133).
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
          reasoningTokens: omitZero(reasoningTokens),
          cachedInputTokens: omitZero(cachedTokens),
          model: state.model ?? "",
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
