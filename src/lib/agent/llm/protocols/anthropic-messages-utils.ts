/**
 * Pure helper functions for the Anthropic Messages protocol.
 * Extracted from anthropic-messages.ts for maintainability.
 */

import type { LLMRequest } from "../route/client";
import { zodToJsonSchema } from "../zod-json-schema";
import { isImagePartV1 } from "../image-part";
import {
  isZodSchema,
  extractScreenshots,
} from "../shared-image";
import type { AnthropicBody, StreamState } from "./anthropic-messages";

export async function fromRequest(request: LLMRequest): Promise<AnthropicBody> {
  if (!request.model || typeof request.model.id !== "string" || request.model.id.length === 0) {
    throw new Error("request.model.id is required and must be a non-empty string");
  }
  const systemMessages = request.messages.filter((m) => m.role === "system");
  const userMessages = request.messages.filter((m) => m.role !== "system");

  const messages = userMessages.map((m) => {
    if (m.role === "user") {
      // Structured image parts (the navigator's screenshot): emit image blocks
      // directly and SKIP the regex scan — the base64 lives only in the part,
      // so no `<screenshot>` marker scan is needed (and a forged marker in
      // text can never be promoted into an image block).
      if (Array.isArray(m.content) && m.content.some(isImagePartV1)) {
        const content: Array<{ type: string; text?: string; source?: unknown }> = [];
        for (const part of m.content) {
          if (typeof part === "string") {
            if (part) content.push({ type: "text", text: part });
          } else {
            content.push({
              type: "image",
              source: { type: "base64", media_type: part.mime, data: part.dataUrl.split(",")[1] ?? "" },
            });
          }
        }
        return { role: "user", content };
      }
      // Parts array WITHOUT an image part: the LLMRequest content type is
      // `Array<string | ImagePartV1>`, so the array can only hold strings.
      // Normalize them into text blocks — a raw string array is not valid
      // Messages-API content, and every other role passes through unchanged.
      if (Array.isArray(m.content)) {
        const content: Array<{ type: string; text: string }> = [];
        for (const part of m.content) {
          if (typeof part === "string" && part) content.push({ type: "text", text: part });
        }
        return { role: m.role, content };
      }
      // Legacy STRING content: extract `<screenshot>` markers as defense-
      // in-depth for callers that still interpolate them into text.
      if (typeof m.content === "string") {
        const { text: textContent, dataUris } = extractScreenshots(m.content);
        if (dataUris.length > 0) {
          const imageBlocks = dataUris.map((dataUri) => {
            const b64 = dataUri.split(",")[1];
            const mediaType = dataUri.match(/data:image\/(png|jpeg|webp)/)?.[1] ?? "png";
            return {
              type: "image",
              source: { type: "base64", media_type: `image/${mediaType}`, data: b64 },
            };
          });
          return {
            role: "user",
            content: [{ type: "text", text: textContent }, ...imageBlocks],
          };
        }
      }
    }
    return { role: m.role, content: m.content };
  });

  const body: AnthropicBody = {
    model: request.model.id,
    max_tokens: request.generation?.maxTokens ?? 4096,
    messages,
    temperature: request.reasoning ? undefined : (request.generation?.temperature ?? 0),
    stream: true,
  };

  // Reasoning configuration replaces the old temperature-omission hack with a
  // real `thinking` block. A forced-off request emits an explicit disabled
  // block and restores temperature; an enabled request (explicit, budget, or
  // effort) emits `{type:"enabled", budget_tokens:N}` with N clamped to
  // min(31_999, output-1) — or derived as min(16_000, output/2-1) when only an
  // effort/enabled signal is given (mirrors opencode's transform layer).
  // Everything is gated on `request.reasoning` (the provider is a reasoning
  // model), so an empty reasoningConfig or a non-reasoning provider changes
  // nothing.
  const reasoningConfig = request.reasoningConfig;
  const reasoningActive = request.reasoning === true && reasoningConfig !== undefined;
  if (reasoningActive && reasoningConfig.enabled === false) {
    body.thinking = { type: "disabled" };
    body.temperature = request.generation?.temperature ?? 0;
  } else if (
    reasoningActive &&
    (reasoningConfig.enabled === true ||
      reasoningConfig.budgetTokens !== undefined ||
      reasoningConfig.effort !== undefined)
  ) {
    const maxOutput = request.generation?.maxTokens ?? 4096;
    const maxBudget = Math.min(31_999, Math.max(1, maxOutput - 1));
    const explicit = reasoningConfig.budgetTokens;
    const budget =
      typeof explicit === "number" && explicit > 0
        ? Math.min(Math.floor(explicit), maxBudget)
        : Math.min(16_000, Math.max(1, Math.floor(maxOutput / 2 - 1)));
    body.thinking = { type: "enabled", budget_tokens: budget };
    body.temperature = undefined;
  }

  // Prompt-cache economics: only emit cache markers when the request is
  // cache-eligible OR the conversation is multi-turn — a cache the call will
  // actually re-read. A stateless one-shot call (one system + one user) never
  // re-reads its own cache write, so emitting cache_control there just pays
  // the cache-write premium for nothing.
  const oneShotTwoMessage = systemMessages.length === 1 && userMessages.length === 1;
  const cacheEligible = request.cacheEligible === true || !oneShotTwoMessage;

  if (systemMessages.length) {
    body.system = [{
      type: "text",
      text: systemMessages.map((m) => m.content).join("\n\n"),
      ...(cacheEligible ? { cache_control: { type: "ephemeral", ttl: "1h" } } : {}),
    }];
  }

  if (request.schema) {
    let jsonSchema: unknown;
    try {
      jsonSchema = isZodSchema(request.schema)
        ? await zodToJsonSchema(request.schema)
        : request.schema;
    } catch (err) {
      throw err instanceof Error
        ? new Error("Failed to serialize structured-output schema: " + err.message)
        : err;
    }
    body.tools = [{ name: "return_json", description: "Return the structured output as JSON", input_schema: jsonSchema, ...(cacheEligible ? { cache_control: { type: "ephemeral", ttl: "1h" } } : {}) }];
    body.tool_choice = { type: "tool", name: "return_json" };
  }

  return body;
}

export function buildMessageStartUsage(
  u: Record<string, unknown>,
  prev: StreamState["usage"],
  model: string,
): NonNullable<StreamState["usage"]> {
  const cacheRead = (u as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0;
  const cacheCreation = (u as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0;
  return {
    tokensIn: ((u as { input_tokens?: number }).input_tokens ?? 0) + cacheRead + cacheCreation,
    tokensOut: (u as { output_tokens?: number }).output_tokens ?? prev?.tokensOut ?? 0,
    cachedInputTokens: cacheRead,
    cachedWriteInputTokens: cacheCreation,
    reasoningTokens: (u as { output_tokens_details?: { reasoning_tokens?: number } }).output_tokens_details?.reasoning_tokens ?? prev?.reasoningTokens,
    model,
    costUsd: 0,
  };
}

export function buildMessageDeltaUsage(
  usage: Record<string, unknown>,
  prev: StreamState["usage"],
  model: string,
): NonNullable<StreamState["usage"]> {
  return {
    tokensIn: prev?.tokensIn ?? 0,
    tokensOut: (usage as { output_tokens?: number }).output_tokens ?? prev?.tokensOut ?? 0,
    cachedInputTokens: prev?.cachedInputTokens ?? 0,
    cachedWriteInputTokens: prev?.cachedWriteInputTokens ?? 0,
    reasoningTokens: (usage as { output_tokens_details?: { reasoning_tokens?: number } }).output_tokens_details?.reasoning_tokens ?? prev?.reasoningTokens,
    model,
    costUsd: 0,
  };
}
