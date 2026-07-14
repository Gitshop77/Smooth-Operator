/**
 * xAI (Grok) provider facade — uses the openai-compatible-chat protocol
 * against `https://api.x.ai/v1/chat/completions` with bearer auth.
 *
 * Auth chain: explicit `apiKey` → `XAI_API_KEY` env var → throw.
 *
 * Built on the shared {@link makeOpenAIChatFacade} factory (see `openai.ts`) so
 * security-relevant boilerplate — the SSRF guard on user-supplied `baseURL`,
 * auth chain, error/framing wiring — lives in one place and cannot diverge
 * between the OpenAI-compatible facades.
 */

import * as OpenAICompatibleChat from "../protocols/openai-compatible-chat";
import { makeOpenAIChatFacade, type Config } from "./openai";
import { profiles } from "./openai-compatible-profile";

export type { Config };

const facade = makeOpenAIChatFacade({
  id: "xai",
  displayName: "xAI",
  envKey: "XAI_API_KEY",
  routeId: "openai-compatible-chat",
  protocol: OpenAICompatibleChat.protocol,
  path: OpenAICompatibleChat.PATH,
  defaultBaseURL: profiles.xai.baseURL,
});

export const id = facade.id;
export const configure = facade.configure;

/**
 * Bridge to the agent's `LLMProvider` interface.
 *
 * `supportsVision: true` — xAI Grok-2 Vision accepts image inputs (see
 * `pricing.ts`'s `grok-2-vision` entry). The per-model catalog lookup in
 * `buildProvider` (provider-config.ts) overrides this for non-vision Grok
 * models (e.g. plain `grok-2`), so setting `true` here is the safe default:
 * vision-capable models are correctly detected, and non-vision models get
 * downgraded by the catalog lookup.
 */
export const toLLMProvider = facade.toLLMProvider;
