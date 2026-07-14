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

export { DEFAULT_BASE_URL, PATH } from "./openai-chat";

/** Default `frequency_penalty` applied to discourage runaway generation. */
const DEFAULT_FREQUENCY_PENALTY = 0.3;

export const protocol: Protocol<OpenAIChat.OpenAIChatBody, string, { type: string; content?: string; usage?: unknown }, OpenAIChat.StreamState> = {
  id: "openai-compatible-chat",
  body: {
    from: async (request) => {
      const body = await OpenAIChat.protocol.body.from(request);
      body.frequency_penalty = DEFAULT_FREQUENCY_PENALTY;
      return body;
    },
  },
  stream: OpenAIChat.protocol.stream,
};

export * as OpenAICompatibleChat from "./openai-compatible-chat";
