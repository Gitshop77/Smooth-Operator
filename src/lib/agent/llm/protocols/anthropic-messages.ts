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
import { fromRequest, buildMessageStartUsage, buildMessageDeltaUsage } from "./anthropic-messages-utils";

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
  /** Thinking configuration: enabled with a token budget, or explicitly disabled. */
  thinking?: { type: "enabled"; budget_tokens: number } | { type: "disabled" };
  system?: Array<{ type: string; text: string; cache_control?: { type: string; ttl?: "1h" | "30m" } }>;
  tools?: Array<{ name: string; description: string; input_schema: unknown; cache_control?: { type: string; ttl?: "1h" | "30m" } }>;
  tool_choice?: { type: string; name: string };
  stream: boolean;
}

export interface StreamState {
  content: string;
  toolInput: string;
  /** Model id captured at stream start so usage attribution survives reduction. */
  model?: string;
  /** Count of non-JSON SSE frames dropped this stream (see DROPPED_FRAME_WARN_THRESHOLD). */
  dropped?: number;
  /** Type of the most recently parsed SSE frame (avoids re-parsing in terminal()). */
  lastFrameType?: string;
  usage?: { tokensIn: number; tokensOut: number; model: string; costUsd: number; cachedInputTokens?: number; cachedWriteInputTokens?: number; reasoningTokens?: number };
}

export const protocol: Protocol<AnthropicBody, string, { type: string; content?: string; usage?: StreamState["usage"] }, StreamState> = {
  id: ADAPTER,
  body: { from: fromRequest },
  stream: {
    initial: (request: LLMRequest) => ({ content: "", toolInput: "", model: request.model.id }),
    step: (state: StreamState, frame: string) => {
      const events: Array<{ type: string; content?: string; usage?: StreamState["usage"] }> = [];
 // Parse the frame in an isolated try/catch. Only a JSON *parse* failure is
 // a benign non-JSON frame to be dropped. Errors thrown while *processing* a
 // valid frame (e.g. a surfaced Anthropic error frame below) must propagate
 // to the caller — folding both into one catch silently swallowed API
 // error frames .
  
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
      state.lastFrameType = data.type;
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
      if (data.type === "message_start" && data.message?.usage) {
        state.usage = buildMessageStartUsage(data.message.usage, state.usage, state.model ?? "");
      }
      if (data.type === "message_delta" && data.usage) {
        state.usage = buildMessageDeltaUsage(data.usage, state.usage, state.model ?? "");
      }
      return { state, events };
    },
    terminal: (frame: string, state?: StreamState): boolean => {
      if (state?.lastFrameType !== undefined) {
        return state.lastFrameType === "message_stop";
      }
      // Fallback: parse the frame when state is not provided (e.g. direct test calls).
      try {
        return JSON.parse(frame).type === "message_stop";
      } catch {
        return false;
      }
    },
  },
};

