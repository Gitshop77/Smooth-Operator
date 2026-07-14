/**
 * Anthropic Messages protocol — implements the
 * `packages/llm/src/protocols/anthropic-messages.ts`.
 *
 * Implements the `/v1/messages` API format with support for:
 * - System message extraction (Anthropic uses a separate `system` param)
 * - Prompt caching (ephemeral cache_control on system)
 * - Vision (screenshot markers → image content blocks)
 * - Tool use for structured output (forced tool call)
 * - SSE streaming with content_block_delta events
 */

import { Protocol, type LLMRequest } from "../route/client";
import { zodToJsonSchema } from "../zod-json-schema";
import {
  SCREENSHOT_PATTERN_G,
  isZodSchema,
  isValidBase64,
  hasImageProvenance,
} from "../shared-image";

const ADAPTER = "anthropic-messages";
export const DEFAULT_BASE_URL = "https://api.anthropic.com";
export const PATH = "/v1/messages";
export const API_VERSION = "2023-06-01";

/**
 * Once this many non-JSON SSE frames have been dropped in a single stream,
 * surface a non-PII warning. A few malformed frames can be a benign proxy
 * artifact, but a sustained run of them means the assistant output is being
 * silently truncated — worth flagging without logging frame contents.
 */
const DROPPED_FRAME_WARN_THRESHOLD = 5;


export interface AnthropicBody {
  model: string;
  max_tokens: number;
  messages: Array<{ role: string; content: unknown }>;
  temperature?: number;
  system?: Array<{ type: string; text: string; cache_control?: { type: string } }>;
  tools?: Array<{ name: string; description: string; input_schema: unknown }>;
  tool_choice?: { type: string; name: string };
  stream: boolean;
}

async function fromRequest(request: LLMRequest): Promise<AnthropicBody> {
  const systemMessages = request.messages.filter((m) => m.role === "system");
  const userMessages = request.messages.filter((m) => m.role !== "system");

 // Only attach the image to the user message that CONTAINS the <screenshot>
 // marker — not every user message. Mirrors the OpenAI protocol's per-message
 // check. Attaching to every user message would duplicate the screenshot
 // across turns in a multi-turn conversation.
  const messages = userMessages.map((m) => {
    if (m.role === "user") {
      const matches = Array.from(m.content.matchAll(SCREENSHOT_PATTERN_G));
      if (matches.length) {
        const textContent = m.content.replace(SCREENSHOT_PATTERN_G, "").trim();
        const imageBlocks = matches.map((match) => {
          const b64 = match[1].split(",")[1];
          if (!isValidBase64(b64)) {
            throw new Error("Invalid base64 payload inside <screenshot> marker (expected png/jpeg/webp base64).");
          }
 // Provenance: reject markers whose payload does not actually decode to
 // an image of the declared type (see hasImageProvenance). Prevents
 // injected <screenshot> markers in scraped/tool content from
 // forwarding attacker-chosen bytes to the model as an image block.
          if (!hasImageProvenance(b64, match[2])) {
            throw new Error("<screenshot> marker failed provenance check: base64 payload does not match its declared image type.");
          }
          return {
            type: "image",
            source: { type: "base64", media_type: `image/${match[2]}`, data: b64 },
          };
        });
        return {
          role: "user",
          content: [{ type: "text", text: textContent }, ...imageBlocks],
        };
      }
    }
    return { role: m.role, content: m.content };
  });

  const body: AnthropicBody = {
    model: request.model.id,
    max_tokens: request.generation?.maxTokens ?? 4096,
    messages,
    temperature: request.generation?.temperature ?? 0,
    stream: true,
  };

  if (systemMessages.length) {
    body.system = [{
      type: "text",
      text: systemMessages.map((m) => m.content).join("\n\n"),
      cache_control: { type: "ephemeral" },
    }];
  }

  if (request.schema) {
 // Serialize the Zod schema to a plain JSON Schema object before passing
 // to Anthropic's input_schema. The raw Zod schema object is not serializable
 // and would be sent as-is (with internal Zod properties), causing 400 errors.
 // If `request.schema` is already a plain JSON Schema, forward it as-is and
 // never silently emit a raw Zod object. A Zod object that can't be converted
 // throws a clear error via `zodToJsonSchema`.
    let jsonSchema: unknown;
    try {
      jsonSchema = isZodSchema(request.schema)
        ? await zodToJsonSchema(request.schema)
        : request.schema;
    } catch (err) {
 // Surface configuration/serialization errors clearly. Only swallow an
 // error when the schema is already a usable plain JSON Schema.
      if (!isZodSchema(request.schema)) {
        jsonSchema = request.schema;
      } else {
        throw err instanceof Error
          ? new Error("Failed to serialize structured-output schema: " + err.message)
          : err;
      }
    }
    body.tools = [{ name: "return_json", description: "Return the structured output as JSON", input_schema: jsonSchema }];
    body.tool_choice = { type: "tool", name: "return_json" };
  }

  return body;
}

export interface StreamState {
  content: string;
  toolInput: string;
  /** Count of non-JSON SSE frames dropped this stream (see DROPPED_FRAME_WARN_THRESHOLD). */
  dropped?: number;
  usage?: { tokensIn: number; tokensOut: number; model: string; costUsd: number; cachedInputTokens?: number; cachedWriteInputTokens?: number; reasoningTokens?: number };
}

export const protocol: Protocol<AnthropicBody, string, { type: string; content?: string; usage?: StreamState["usage"] }, StreamState> = {
  id: ADAPTER,
  body: { from: fromRequest },
  stream: {
    initial: () => ({ content: "", toolInput: "" }),
    step: (state: StreamState, frame: string) => {
      const events: Array<{ type: string; content?: string; usage?: StreamState["usage"] }> = [];
 // Parse the frame in an isolated try/catch. Only a JSON *parse* failure is
 // a benign non-JSON frame to be dropped. Errors thrown while *processing* a
 // valid frame (e.g. a surfaced Anthropic error frame below) must propagate
 // to the caller — folding both into one catch silently swallowed API
 // error frames .
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let data: any;
      try {
        data = JSON.parse(frame);
      } catch {
 // Non-JSON frame — surface for debugging instead of discarding silently.
 // Log only the byte length; the raw frame can contain model output /
 // scraped page content (PII, secrets) that must not leak into logs.
        console.warn(`[anthropic-messages] Skipping non-JSON SSE frame (${frame.length} bytes)`);
 // Count dropped frames; warn once if a sustained run of them suggests the
 // assistant output is being silently truncated (no frame contents logged).
        state.dropped = (state.dropped ?? 0) + 1;
        if (state.dropped === DROPPED_FRAME_WARN_THRESHOLD) {
          console.warn(
            `[anthropic-messages] ${DROPPED_FRAME_WARN_THRESHOLD} non-JSON SSE frames dropped this stream — ` +
              `assistant output may be truncated.`,
          );
        }
        return { state, events };
      }
      {
        if (data.type === "error") {
 // Anthropic error payloads (`{"type":"error","error":{...}}`) are
 // valid JSON, so they parse without throwing — but they carry no
 // `content`, so the caller would otherwise receive empty output and
 // a success-like completion, masking auth/quota/permission failures.
 // Surface the error explicitly instead of swallowing it.
          const err = data.error as { message?: string } | string | undefined;
          const msg = typeof err === "string" ? err : (err?.message ?? JSON.stringify(data.error ?? data));
          throw new Error(`Anthropic API error: ${msg}`);
        }
        if (data.type === "content_block_delta" && data.delta?.text) {
          state.content += data.delta.text;
          events.push({ type: "text", content: data.delta.text });
        }
        if (data.type === "content_block_delta" && data.delta?.type === "input_json_delta" && data.delta?.partial_json) {
          state.toolInput += data.delta.partial_json;
        }
        if (data.type === "message_stop") {
          if (state.toolInput) {
            events.push({ type: "text", content: state.toolInput });
          }
          events.push({ type: "finish", usage: state.usage });
        }
 // Anthropic's SSE format sends `input_tokens` in the `message_start`
 // event (under `data.message.usage`), NOT in `message_delta`. The
 // `message_delta` event only carries `output_tokens` (cumulative).
 // Capture `input_tokens` here so `tokensIn` is reported correctly
 // (otherwise cost tracking would under-report for Anthropic models).
        if (data.type === "message_start" && data.message?.usage) {
          const prev = state.usage;
          const u = data.message.usage;
 // Anthropic's `input_tokens` is FRESH-only (disjoint from cache_read
 // + cache_creation), unlike OpenAI's `prompt_tokens` which is the
 // TOTAL. `estimateCost` (pricing.ts) clamps `cachedRead =
 // Math.min(cachedInputTokens, tokensIn)` assuming cached ⊆ tokensIn
 // (OpenAI semantics). To make the clamp correct for Anthropic, set
 // tokensIn to the TOTAL (fresh + cache_read + cache_creation) so
 // `freshInput = tokensIn - cachedRead - cachedWrite` = fresh-only
 // (correct).
 // Split prompt-cache accounting:
 // cache_read_input_tokens -> cachedInputTokens (billed at cacheReadRate)
 // cache_creation_input_tokens -> cachedWriteInputTokens (billed at cacheWriteRate)
 // Previously cache_creation was folded into cachedInputTokens and
 // billed at the cheaper read rate, under-reporting cost. Now it is
 // tracked separately and billed at the (typically higher) write rate.
          const cacheRead = u.cache_read_input_tokens ?? 0;
          const cacheCreation = u.cache_creation_input_tokens ?? 0;
          state.usage = {
            tokensIn: (u.input_tokens ?? 0) + cacheRead + cacheCreation,
            tokensOut: u.output_tokens ?? prev?.tokensOut ?? 0,
 // Anthropic prompt caching: cache_read tokens billed at 0.1× input
 // rate, cache_creation at 1.25×. Tracking them separately lets
 // estimateCost bill each at its own rate (fixes under-billing).
            cachedInputTokens: cacheRead,
            cachedWriteInputTokens: cacheCreation,
 // Extended-thinking reasoning tokens (Anthropic bills these at the
 // `out` rate). Surface them so consumers can attribute think-budget usage.
            reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? prev?.reasoningTokens,
            model: "",
            costUsd: 0,
          };
        }
 // The `message_delta` event only carries output_tokens (cumulative).
 // Preserve any previously-captured tokensIn + cachedInputTokens +
 // cachedWriteInputTokens from message_start rather than overwriting
 // them with 0.
        if (data.type === "message_delta" && data.usage) {
          const prev = state.usage;
          state.usage = {
            tokensIn: prev?.tokensIn ?? 0,
            tokensOut: data.usage.output_tokens ?? prev?.tokensOut ?? 0,
 // Default to 0 (not `undefined`) so downstream `Math.min(cachedInputTokens, tokensIn)`
 // in `estimateCost` never computes `NaN`. A missing `message_start`
 // usage would otherwise leave these `undefined` (see [4]).
            cachedInputTokens: prev?.cachedInputTokens ?? 0,
            cachedWriteInputTokens: prev?.cachedWriteInputTokens ?? 0,
            reasoningTokens: data.usage.output_tokens_details?.reasoning_tokens ?? prev?.reasoningTokens,
            model: "",
            costUsd: 0,
          };
        }
      }
      return { state, events };
    },
    terminal: (frame: string): boolean => {
      try {
        return JSON.parse(frame).type === "message_stop";
      } catch {
 // Non-JSON frame — not a terminal marker; log for debugging (length only).
        console.warn(`[anthropic-messages] Terminal check on non-JSON SSE frame (${frame.length} bytes)`);
        return false;
      }
    },
  },
};

