/**
 * OpenRouter provider facade — uses the openai-compatible-chat protocol
 * against `https://openrouter.ai/api/v1/chat/completions` with bearer auth.
 *
 * Auth chain: explicit `apiKey` → `OPENROUTER_API_KEY` env var → throw.
 *
 * The shared OpenAI-compatible boilerplate is provided by
 * `makeOpenAIChatFacade` in `./openai` (kept there so xAI and any future
 * OpenAI-compatible facade reuse this single implementation, keeping the SSRF
 * guard and auth wiring from diverging).
 */

import * as OpenAICompatibleChat from "../protocols/openai-compatible-chat";
import { profiles } from "./openai-compatible-profile";
import { makeOpenAIChatFacade, type Config } from "./openai";

const facade = makeOpenAIChatFacade({
  id: "openrouter",
  displayName: "OpenRouter",
  envKey: "OPENROUTER_API_KEY",
  routeId: "openai-compatible-chat",
  protocol: OpenAICompatibleChat.protocol,
  path: OpenAICompatibleChat.PATH,
  defaultBaseURL: profiles.openrouter.baseURL,
});

export const id = facade.id;
export const configure = facade.configure;
export const toLLMProvider = facade.toLLMProvider;
export type { Config };
