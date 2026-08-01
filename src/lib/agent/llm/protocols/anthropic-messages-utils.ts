/**
 * Pure helper functions for the Anthropic Messages protocol.
 * Extracted from anthropic-messages.ts for maintainability.
 */

import type { LLMRequest } from "../route/client";
import { zodToJsonSchema } from "../zod-json-schema";
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
    return { role: m.role, content: m.content };
  });

  const body: AnthropicBody = {
    model: request.model.id,
    max_tokens: request.generation?.maxTokens ?? 4096,
    messages,
    temperature: request.reasoning ? undefined : (request.generation?.temperature ?? 0),
    stream: true,
  };

  if (systemMessages.length) {
    body.system = [{
      type: "text",
      text: systemMessages.map((m) => m.content).join("\n\n"),
      cache_control: { type: "ephemeral", ttl: "1h" },
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
    body.tools = [{ name: "return_json", description: "Return the structured output as JSON", input_schema: jsonSchema, cache_control: { type: "ephemeral", ttl: "1h" } }];
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
