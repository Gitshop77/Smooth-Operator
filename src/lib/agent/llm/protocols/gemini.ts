/**
 * Google Gemini protocol — implements the
 * `packages/llm/src/protocols/gemini.ts`.
 *
 * Implements the `:generateContent` + `:streamGenerateContent` API format
 * with support for vision (inline_data), structured output (responseSchema),
 * and system instruction.
 */

import { Protocol, type LLMRequest } from "../route/client";
import { encodeModelIdForUrl } from "../modelId";
import { zodToJsonSchema } from "../zod-json-schema";

const ADAPTER = "gemini";
export const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
export const PATH = ":streamGenerateContent";

const SCREENSHOT_PATTERN = /<screenshot>(data:image\/(png|jpeg|webp);base64,[^<]+)<\/screenshot>/g;

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

export interface GeminiBody {
  contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
  generationConfig: {
    temperature?: number;
    maxOutputTokens?: number;
    responseMimeType?: string;
    responseSchema?: unknown;
  };
  systemInstruction?: { parts: Array<{ text: string }> };
}

async function fromRequest(request: LLMRequest): Promise<GeminiBody> {
  const systemMsg = request.messages.find((m) => m.role === "system");
  const userMessages = request.messages.filter((m) => m.role !== "system");

  // Only attach the image to the user message that CONTAINS the <screenshot>
  // marker — not every user message. Mirrors the OpenAI + Anthropic protocols.
  const contents = userMessages.map((m) => {
    const textContent = m.content.replace(/<screenshot>[^<]+<\/screenshot>/g, "").trim();
    if (m.role === "user") {
      // Extract EVERY screenshot marker (not just the first) into its own
      // `inline_data` part — a multi-screenshot turn must forward all of them.
      const matches = Array.from(m.content.matchAll(SCREENSHOT_PATTERN));
      if (matches.length > 0) {
        const parts: Record<string, unknown>[] = [];
        if (textContent) parts.push({ text: textContent });
        for (const match of matches) {
          const dataUri = match[1];
          const b64 = dataUri.split(",")[1];
          if (!isValidBase64(b64 ?? "")) {
            throw new Error("Invalid base64 screenshot payload in user message");
          }
          parts.push({ inline_data: { mime_type: `image/${match[2]}`, data: b64 } });
        }
        return { role: "user", parts };
      }
    }
    return { role: m.role === "assistant" ? "model" : "user", parts: [{ text: textContent }] };
  });

  const generationConfig: GeminiBody["generationConfig"] = {
    temperature: request.generation?.temperature ?? 0,
    maxOutputTokens: request.generation?.maxTokens ?? 8192,
  };
  if (request.schema) {
    // Serialize the Zod schema to a plain JSON Schema object before passing
    // to Gemini's responseSchema. The raw Zod schema object is not serializable.
    //
    // If `request.schema` is ALREADY a plain JSON Schema (e.g. `{ type:
    // "object" }` — the shape callers/tests pass), forward it as-is. Calling
    // `z.toJSONSchema` on a non-Zod object throws ("reading 'def'"), which was
    // a genuine regression. Only Zod objects need conversion; we still THROW on
    // any conversion failure so a non-serializable schema surfaces clearly
    // rather than being POSTed as a raw Zod object (opaque `400`).
    let jsonSchema: unknown;
    if (isZodSchema(request.schema)) {
      jsonSchema = await zodToJsonSchema(request.schema);
    } else {
      jsonSchema = request.schema;
    }
    if (!isPlainJSONSchema(jsonSchema)) {
      throw new Error("Response schema did not produce a serializable JSON Schema object");
    }
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = jsonSchema;
  }

  const body: GeminiBody = { contents, generationConfig };
  if (systemMsg) body.systemInstruction = { parts: [{ text: systemMsg.content }] };
  return body;
}

interface StreamState {
  content: string;
  usage?: { tokensIn: number; tokensOut: number; reasoningTokens?: number; cachedInputTokens?: number; model: string; costUsd: number };
}

export const protocol: Protocol<GeminiBody, string, { type: string; content?: string; usage?: StreamState["usage"] }, StreamState> = {
  id: ADAPTER,
  body: { from: fromRequest },
  stream: {
    initial: () => ({ content: "" }),
    step: (state: StreamState, frame: string) => {
      const events: Array<{ type: string; content?: string; usage?: StreamState["usage"] }> = [];
      // Separate the two distinct failure modes:
      //   1. A non-JSON frame (truncated stream / proxy artifact) — log it and
      //      skip, consistent with `anthropic-messages.ts`.
      //   2. A provider error payload (`{"error": {...}}`) — valid JSON, so it
      //      parses fine, but it must NOT be swallowed: we throw so the route
      //      propagates it instead of returning empty output that masks
      //      auth/quota/permission failures.
      let data: unknown;
      try {
        data = JSON.parse(frame);
      } catch {
        // Log only the byte length — the raw frame can carry model output or
        // scraped page content (PII, secrets) that must not leak into logs.
        console.warn(`[gemini] Dropping non-JSON SSE frame (${frame.length} bytes)`);
        return { state, events };
      }
      const dataAny = data as { error?: { message?: string } | string };
      if (dataAny.error) {
        const err = dataAny.error;
        const msg = typeof err === "string" ? err : (err.message ?? JSON.stringify(err));
        throw new Error(`Gemini API error: ${msg}`);
      }
      const parts = (data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }).candidates?.[0]?.content?.parts;
      if (parts) {
        for (const p of parts) {
          if (p.text) {
            state.content += p.text;
            events.push({ type: "text", content: p.text });
          }
        }
      }
      const usage = (data as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number; thoughtsTokenCount?: number } }).usageMetadata;
      if (usage) {
        // Capture cachedContentTokenCount (cached → billed at cacheRead
        // rate) + thoughtsTokenCount (Gemini 2.5 Flash/Pro Thinking
        // reasoning tokens, billed at $0 without this → under-reporting
        // 30-60%).
        const cached = usage.cachedContentTokenCount;
        const reasoning = usage.thoughtsTokenCount;
        state.usage = {
          tokensIn: usage.promptTokenCount ?? 0,
          tokensOut: usage.candidatesTokenCount ?? 0,
          reasoningTokens: typeof reasoning === "number" && reasoning > 0 ? reasoning : undefined,
          cachedInputTokens: typeof cached === "number" && cached > 0 ? cached : undefined,
          model: "",
          costUsd: 0,
        };
      }
      return { state, events };
    },
    terminal: (frame: string): boolean => {
      // Gemini sends usageMetadata only on the final chunk (confirmed
      // via API docs + community reports). But some edge cases (empty
      // responses with finishReason=STOP but no content) can also carry
      // usageMetadata. The safest terminal signal is finishReason on a
      // candidate — that's the API's explicit "I'm done" marker. We also
      // accept usageMetadata as a fallback for older API versions.
      try {
        const data = JSON.parse(frame);
        // Primary: check for finishReason on the first candidate
        const finishReason = data.candidates?.[0]?.finishReason;
        if (finishReason && finishReason !== "FINISH_REASON_UNSPECIFIED") {
          return true;
        }
        // Fallback: usageMetadata presence (older API versions)
        if (data.usageMetadata) {
          return true;
        }
        return false;
      } catch {
        return false;
      }
    },
  },
};

/** Build the Gemini endpoint path for a specific model (uses dynamic path). */
export function geminiPath(model: string): string {
  // `encodeModelIdForUrl` keeps normal ids identical (alphanumerics, ".", "-"
  // are left untouched) but prevents a malicious/garbage model id from
  // injecting path separators or query characters into the request URL, and
  // throws on structurally-invalid ids.
  return `/${encodeModelIdForUrl(model)}${PATH}`;
}

export * as Gemini from "./gemini";
