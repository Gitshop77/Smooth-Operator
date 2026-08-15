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
import { isImagePartV1 } from "../image-part";
import {
  isZodSchema,
  isPlainJSONSchema,
  extractScreenshots,
} from "../shared-image";

const ADAPTER = "gemini";
export const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const PATH = ":streamGenerateContent";

/**
 * Once this many non-JSON SSE frames have been dropped in a single stream,
 * surface a non-PII warning. A few malformed frames can be a benign proxy
 * artifact, but a sustained run of them means the assistant output is being
 * silently truncated — worth flagging without logging frame contents.
 */
const DROPPED_FRAME_WARN_THRESHOLD = 5;

/**
 * Upper bound for `thinkingConfig.thinkingBudget` — Google's documented
 * maximum thinking budget for Gemini reasoning models. A configured budget
 * beyond this (e.g. a huge `reasoningBudget` setting) is clamped so the API
 * never receives an out-of-range value.
 */
export const MAX_THINKING_BUDGET = 32_768;


export interface GeminiBody {
  contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
  generationConfig: {
    temperature?: number;
    maxOutputTokens?: number;
    responseMimeType?: string;
    responseSchema?: unknown;
    thinkingConfig?: { thinkingBudget: number };
  };
  systemInstruction?: { parts: Array<{ text: string }> };
}

async function fromRequest(request: LLMRequest): Promise<GeminiBody> {
  const systemMessages = request.messages.filter((m) => m.role === "system");
  const systemText = systemMessages.map((m) => m.content).join("\n\n");
  const userMessages = request.messages.filter((m) => m.role !== "system");

// Only attach the image to the user message that CONTAINS the <screenshot>
  // marker (legacy) or an ImagePartV1 part — not every user message. Mirrors
  // the OpenAI + Anthropic protocols.
  const contents = userMessages.map((m) => {
    if (m.role === "user") {
      // Structured image parts (the navigator's screenshot): emit inline_data
      // parts directly and SKIP the regex scan — the base64 lives only in the
      // part, so a forged `<screenshot>` marker in text can never be promoted
      // into an image block.
      if (Array.isArray(m.content) && m.content.some(isImagePartV1)) {
        const parts: Record<string, unknown>[] = [];
        for (const part of m.content) {
          if (typeof part === "string") {
            if (part) parts.push({ text: part });
          } else {
            parts.push({
              inline_data: { mime_type: part.mime, data: part.dataUrl.split(",")[1] ?? "" },
            });
          }
        }
        return { role: "user", parts };
      }
      // Legacy STRING content: extract `<screenshot>` markers as defense-
      // in-depth for callers that still interpolate them into text. Parts
      // arrays without an image part flatten to their text only.
      if (typeof m.content === "string") {
        const { text: textContent, dataUris } = extractScreenshots(m.content);
        if (dataUris.length > 0) {
          const parts: Record<string, unknown>[] = [];
          if (textContent) parts.push({ text: textContent });
          for (const dataUri of dataUris) {
            const b64 = dataUri.split(",")[1];
            const mediaType = dataUri.match(/data:image\/(png|jpeg|webp)/)?.[1] ?? "png";
            parts.push({ inline_data: { mime_type: `image/${mediaType}`, data: b64 } });
          }
          return { role: "user", parts };
        }
        return { role: "user", parts: [{ text: textContent }] };
      }
      return { role: "user", parts: [{ text: m.content.filter((p) => typeof p === "string").join("") }] };
    }
    // Non-user messages never carry image parts — flatten any parts array to
    // its text defensively.
    const text = typeof m.content === "string"
      ? m.content
      : m.content.filter((p) => typeof p === "string").join("");
    return { role: m.role === "assistant" ? "model" : "user", parts: [{ text: text.trim() }] };
  });

  const generationConfig: GeminiBody["generationConfig"] = {
  // Reasoning models (Gemini 3.x) deprecate temperature/top_p/top_k: the
  // params are ignored on 3.6 Flash / 3.5 Flash-Lite and "will result in an
  // HTTP 400 error in future model generations" per Google's docs. Mirror the
  // openai-chat / anthropic-messages protocols: omit temperature for
  // `request.reasoning` models; `maxOutputTokens` is still sent (it is the
  // thinking budget on reasoning models). `enabled: false` (user forced
  // reasoning off) restores the non-reasoning params.
    ...(request.reasoning && request.reasoningConfig?.enabled !== false
      ? {}
      : { temperature: request.generation?.temperature ?? 0 }),
    maxOutputTokens: request.generation?.maxTokens ?? 8192,
  };
  // Thinking budget: only when the model is reasoning (and not forced off) and
  // a positive budget is configured — mirrors the opencode transform layer's
  // `thinkingConfig: { thinkingBudget }`.
  if (
    request.reasoning &&
    request.reasoningConfig?.enabled !== false &&
    request.reasoningConfig?.budgetTokens !== undefined &&
    request.reasoningConfig.budgetTokens > 0
  ) {
    generationConfig.thinkingConfig = {
      thinkingBudget: Math.min(MAX_THINKING_BUDGET, Math.floor(request.reasoningConfig.budgetTokens)),
    };
  }
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
      // `z.toJSONSchema` output carries a non-enumerable `~standard` property
      // (zod 4.4.3) that makes the plainness check below reject every real
      // Zod schema — round-trip through JSON to strip it.
      jsonSchema = JSON.parse(JSON.stringify(await zodToJsonSchema(request.schema)));
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
  if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
  return body;
}

interface StreamState {
  content: string;
  /** Model id captured at stream start so usage attribution survives reduction. */
  model?: string;
  /** Count of non-JSON SSE frames dropped this stream (see DROPPED_FRAME_WARN_THRESHOLD). */
  dropped?: number;
  /** A thinking-only part was seen; its text is never treated as user-visible output. */
  reasoningObserved?: boolean;
  /** Last provider terminal reason, retained only as a machine-readable tag. */
  finishReason?: string;
  usage?: { tokensIn: number; tokensOut: number; reasoningTokens?: number; cachedInputTokens?: number; model: string; costUsd: number };
}

export const protocol: Protocol<GeminiBody, string, { type: string; content?: string; usage?: StreamState["usage"] }, StreamState> = {
  id: ADAPTER,
  body: { from: fromRequest },
  stream: {
    initial: (request: LLMRequest) => ({ content: "", model: request.model.id }),
    step: (state: StreamState, frame: string) => {
      const events: Array<{ type: string; content?: string; usage?: StreamState["usage"] }> = [];
 // Separate the two distinct failure modes:
 // 1. A non-JSON frame (truncated stream / proxy artifact) — log it and
 // skip, consistent with `anthropic-messages.ts`.
 // 2. A provider error payload (`{"error": {...}}`) — valid JSON, so it
 // parses fine, but it must NOT be swallowed: we throw so the route
 // propagates it instead of returning empty output that masks
 // auth/quota/permission failures.
      let data: unknown;
      try {
        data = JSON.parse(frame);
      } catch {
 // Log only the byte length — the raw frame can carry model output or
 // scraped page content (PII, secrets) that must not leak into logs.
        console.warn(`[gemini] Dropping non-JSON SSE frame (${frame.length} bytes)`);
 // Count dropped frames; warn once if a sustained run of them suggests the
 // assistant output is being silently truncated (no frame contents logged).
        state.dropped = (state.dropped ?? 0) + 1;
        if (state.dropped === DROPPED_FRAME_WARN_THRESHOLD) {
          console.warn(
            `[gemini] ${DROPPED_FRAME_WARN_THRESHOLD} non-JSON SSE frames dropped this stream — ` +
              `assistant output may be truncated.`,
          );
        }
        return { state, events };
      }
      const dataAny = data as { error?: { message?: string } | string };
      if (dataAny.error) {
        const err = dataAny.error;
        const msg = typeof err === "string" ? err : (err.message ?? JSON.stringify(err));
        throw new Error(`Gemini API error: ${msg}`);
      }
      const candidate = (data as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string; thought?: boolean }> };
          finishReason?: string;
        }>;
      }).candidates?.[0];
      const parts = candidate?.content?.parts;
      if (parts) {
        for (const p of parts) {
          if (p.thought === true) {
            // Gemini thought text is internal reasoning, not a visible answer.
            // Preserve only a boolean aggregate for safe terminal diagnostics.
            state.reasoningObserved = true;
            continue;
          }
          if (p.text) {
            state.content += p.text;
            events.push({ type: "text", content: p.text });
          }
        }
      }
      if (candidate?.finishReason) state.finishReason = candidate.finishReason;
      const usage = (data as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number; thoughtsTokenCount?: number } }).usageMetadata;
      if (usage) {
 // Capture cachedContentTokenCount (cached → billed at cacheRead
 // rate) + thoughtsTokenCount (Gemini 2.5 Flash/Pro Thinking
 // reasoning tokens, billed at $0 without this → under-reporting
 // 30-60%).
 //
 // tokensOut semantics (verified against the upstream opencode
 // `packages/llm/src/protocols/gemini.ts` `mapUsage`, which this protocol
 // mirrors): `candidatesTokenCount` is VISIBLE-ONLY — Gemini counts thinking
 // parts separately from candidate content parts — so summing
 // `candidatesTokenCount + thoughtsTokenCount` is the inclusive output total
 // and does NOT double-count. Google's pricing docs likewise state response
 // pricing is "the sum of output tokens and thinking tokens".
        const cached = usage.cachedContentTokenCount;
        const reasoning = usage.thoughtsTokenCount;
        if (typeof reasoning === "number" && reasoning > 0) state.reasoningObserved = true;
        state.usage = {
          tokensIn: usage.promptTokenCount ?? 0,
          tokensOut: (usage.candidatesTokenCount ?? 0) + (typeof reasoning === "number" && reasoning > 0 ? reasoning : 0),
          reasoningTokens: typeof reasoning === "number" && reasoning > 0 ? reasoning : undefined,
          cachedInputTokens: typeof cached === "number" && cached > 0 ? cached : undefined,
          model: state.model ?? "",
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
    completion: (state: StreamState) => ({
      reasoningObserved: state.reasoningObserved,
      reasoningTokens: state.usage?.reasoningTokens,
      finishReason: state.finishReason,
      droppedFrames: state.dropped,
    }),
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
