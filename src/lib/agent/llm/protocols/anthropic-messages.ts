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

const ADAPTER = "anthropic-messages";
export const DEFAULT_BASE_URL = "https://api.anthropic.com";
export const PATH = "/v1/messages";
export const API_VERSION = "2023-06-01";

/** Match a `<screenshot>data:image/...;base64,...</screenshot>` marker. */
const SCREENSHOT_PATTERN = /<screenshot>(data:image\/(png|jpeg|webp);base64,[^<]+)<\/screenshot>/;


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
  const systemMsg = request.messages.find((m) => m.role === "system");
  const userMessages = request.messages.filter((m) => m.role !== "system");

  // Only attach the image to the user message that CONTAINS the <screenshot>
  // marker — not every user message. Mirrors the OpenAI protocol's per-message
  // check. Attaching to every user message would duplicate the screenshot
  // across turns in a multi-turn conversation.
  const messages = userMessages.map((m) => {
    if (m.role === "user") {
      const match = m.content.match(SCREENSHOT_PATTERN);
      if (match) {
        const textContent = m.content.replace(/<screenshot>[^<]+<\/screenshot>/g, "").trim();
        return {
          role: "user",
          content: [
            { type: "text", text: textContent },
            { type: "image", source: { type: "base64", media_type: `image/${match[2]}`, data: match[1].split(",")[1] } },
          ],
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

  if (systemMsg) {
    body.system = [{ type: "text", text: systemMsg.content, cache_control: { type: "ephemeral" } }];
  }

  if (request.schema) {
    // Serialize the Zod schema to a plain JSON Schema object before passing
    // to Anthropic's input_schema. The raw Zod schema object is not serializable
    // and would be sent as-is (with internal Zod properties), causing 400 errors.
    let jsonSchema: unknown = request.schema;
    try {
      const zNS = (await import("zod")).z as unknown as { toJSONSchema?: (s: unknown) => unknown };
      if (typeof zNS.toJSONSchema === "function") {
        jsonSchema = zNS.toJSONSchema(request.schema);
      }
    } catch { /* fall back to raw if z.toJSONSchema unavailable */ }
    body.tools = [{ name: "return_json", description: "Return the structured output as JSON", input_schema: jsonSchema }];
    body.tool_choice = { type: "tool", name: "return_json" };
  }

  return body;
}

export interface StreamState {
  content: string;
  toolInput: string;
  usage?: { tokensIn: number; tokensOut: number; model: string; costUsd: number; cachedInputTokens?: number; cachedWriteInputTokens?: number; reasoningTokens?: number };
}

export const protocol: Protocol<AnthropicBody, string, { type: string; content?: string; usage?: StreamState["usage"] }, StreamState> = {
  id: ADAPTER,
  body: { from: fromRequest },
  stream: {
    initial: () => ({ content: "", toolInput: "" }),
    step: (state: StreamState, frame: string) => {
      const events: Array<{ type: string; content?: string; usage?: StreamState["usage"] }> = [];
      try {
        const data = JSON.parse(frame);
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
          //   cache_read_input_tokens  -> cachedInputTokens  (billed at cacheReadRate)
          //   cache_creation_input_tokens -> cachedWriteInputTokens (billed at cacheWriteRate)
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
            reasoningTokens: prev?.reasoningTokens,
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
            cachedInputTokens: prev?.cachedInputTokens,
            cachedWriteInputTokens: prev?.cachedWriteInputTokens,
            reasoningTokens: prev?.reasoningTokens,
            model: "",
            costUsd: 0,
          };
        }
      } catch {
        // Non-JSON — skip
      }
      return { state, events };
    },
    terminal: (frame: string): boolean => {
      try {
        return JSON.parse(frame).type === "message_stop";
      } catch {
        return false;
      }
    },
  },
};

export * as AnthropicMessages from "./anthropic-messages";
