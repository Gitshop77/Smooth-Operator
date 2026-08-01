/**
 * OpenAI-compatible Chat protocol — same as openai-chat
 * `packages/llm/src/protocols/openai-compatible-chat.ts`.
 *
 * Same as openai-chat but for providers that speak the OpenAI Chat format
 * at a different base URL (DeepSeek, Groq, Together, Ollama, etc.).
 * Adds `frequency_penalty` by default to prevent infinite generation.
 */

import { Protocol } from "../route/client";
import * as OpenAIChat from "./openai-chat";

export { PATH } from "./openai-chat";

/** Default `frequency_penalty` applied to discourage runaway generation. */
const DEFAULT_FREQUENCY_PENALTY = 0.3;

export const protocol: Protocol<OpenAIChat.OpenAIChatBody, string, { type: string; content?: string; usage?: unknown }, OpenAIChat.StreamState> = {
  id: "openai-compatible-chat",
  body: {
    from: async (request) => {
      const body = await OpenAIChat.protocol.body.from(request);
 // `frequency_penalty` is rejected by reasoning models (o-series /
 // grok-reasoning) — skip it when `request.reasoning` is set.
      if (!request.reasoning) {
        body.frequency_penalty = DEFAULT_FREQUENCY_PENALTY;
      }
 // OpenAI-compatible providers (DeepSeek, Ollama, Qwen, Fireworks, …)
 // 400 on strict JSON-schema mode. Unless the caller explicitly opts into
 // strict mode, downgrade the `json_schema` response_format to plain
 // `json_object` and let the in-prompt schema fallback carry the contract.
      if (!request.structuredOutputStrict && body.response_format?.type === "json_schema") {
        body.response_format = { type: "json_object" };
      }
      return body;
    },
  },
  stream: OpenAIChat.protocol.stream,
};
