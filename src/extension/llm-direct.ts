/**
 * Direct LLM calls — builds the navigator/planner messages and calls the LLM
 * provider directly. Used by the Chrome extension's background worker.
 *
 * The extension:
 *   1. Builds the system + user messages.
 *   2. Resolves the provider from `chrome.storage.local` config.
 *   3. Calls `provider.chat()` directly (the provider uses `fetch` to the LLM
 *      API, which works because the extension has `host_permissions:
 *      ["<all_urls>"]`).
 *   4. Parses the output.
 *
 * No server, no env vars. The extension is fully self-contained.
 */

import type { LLMProvider, ChatMessage } from "../lib/agent/llm/provider";
import { buildNavigatorPrompt } from "../lib/agent/prompts/navigator-prompt";
import { buildPlannerPrompt } from "../lib/agent/prompts/planner-prompt";
import { buildNavigatorUserMessage, buildPlannerUserMessage } from "../lib/agent/loop/messages";
import { AgentOutputSchema, PlannerOutputSchema } from "../lib/agent/tools/schema";
import { getFormatInstructions } from "../lib/agent/tools/registry";
import type { AgentStepRequest, PlannerStepRequest } from "../lib/agent/types";
import { buildProvider, readProviderConfig } from "./provider-config";
// Import the canonical constants from validations.ts instead of re-declaring
// them as magic numbers — now they share the same source of truth.
import { MAX_ACTIONS, MAX_ELEMENTS_CHARS } from "@/lib/validations";

/** Cached provider instance + the config it was built from (rebuilt on config change). */
let cachedProvider: LLMProvider | null = null;
let cachedConfigKey: string | null = null;
/** In-flight promise + its key — prevents double-building when two calls race. */
let pendingProvider: Promise<LLMProvider> | null = null;
let pendingProviderKey: string | null = null;

// Cached prompt overrides + vision mode (invalidated on chrome.storage.onChanged).
let cachedCustomNavigatorPrompt: string | undefined | null = null;
let cachedCustomPlannerPrompt: string | undefined | null = null;
let cachedVisionMode: string | null = null;

if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local") {
      if (changes.customNavigatorPrompt) cachedCustomNavigatorPrompt = null;
      if (changes.customPlannerPrompt) cachedCustomPlannerPrompt = null;
      if (changes.visionMode || changes.enableLocalVision) cachedVisionMode = null;
    }
  });
}

async function getCustomNavigatorPrompt(): Promise<string | undefined> {
  if (cachedCustomNavigatorPrompt !== null) return cachedCustomNavigatorPrompt ?? undefined;
  const { customNavigatorPrompt } = await chrome.storage.local.get("customNavigatorPrompt");
  cachedCustomNavigatorPrompt = (customNavigatorPrompt as string | undefined) ?? "";
  return cachedCustomNavigatorPrompt ?? undefined;
}

async function getCustomPlannerPrompt(): Promise<string | undefined> {
  if (cachedCustomPlannerPrompt !== null) return cachedCustomPlannerPrompt ?? undefined;
  const { customPlannerPrompt } = await chrome.storage.local.get("customPlannerPrompt");
  cachedCustomPlannerPrompt = (customPlannerPrompt as string | undefined) ?? "";
  return cachedCustomPlannerPrompt ?? undefined;
}

async function getVisionMode(): Promise<"disabled" | "always" | "adaptive"> {
  if (cachedVisionMode !== null) return cachedVisionMode as "disabled" | "always" | "adaptive";
  // `visionMode` is the single source of truth (disabled | always | adaptive).
  // `enableLocalVision` is a legacy key kept only for one-time backward
  // compatibility: if `visionMode` is unset but `enableLocalVision` was true,
  // treat it as "always". New code should only ever write `visionMode`.
  const { visionMode, enableLocalVision } = await chrome.storage.local.get(["visionMode", "enableLocalVision"]);
  const mode = (visionMode as string) || (enableLocalVision === true ? "always" : "disabled");
  cachedVisionMode = mode;
  return mode as "disabled" | "always" | "adaptive";
}

/**
 * Resolve the LLM provider from the user's stored config. Caches the instance
 * until the config changes (so we don't rebuild on every step).
 *
 * Uses an in-flight promise to prevent double-building when two concurrent
 * calls (e.g. navigator + planner) race to build the same provider.
 *
 * @throws if no provider is configured or the API key is missing.
 */
async function getProvider(): Promise<LLMProvider> {
  const config = await readProviderConfig();
  if (!config) {
    throw new Error(
      "No LLM provider configured. Open the extension Options page, choose a provider, and enter your API key."
    );
  }
  // Cache key: provider + apiKey + model + baseUrl + resourceName. If any
  // change, rebuild. `resourceName` is included so an Azure resource swap
  // (which changes the constructed endpoint) forces a provider rebuild rather
  // than reusing a stale cached instance bound to the old resource.
  const key = `${config.provider}|${config.apiKey}|${config.model}|${config.baseUrl ?? ""}|${config.resourceName ?? ""}`;
  if (cachedProvider && key === cachedConfigKey) return cachedProvider;
  // If a build is already in-flight for THIS key, await it instead of
  // starting a second concurrent buildProvider() call.
  if (pendingProvider && key === pendingProviderKey) return pendingProvider;
  pendingProviderKey = key;
  // Capture the in-flight promise locally so its resolve/reject closures only
  // clear the SHARED `pendingProvider`/`pendingProviderKey` when they still
  // refer to THIS promise. Otherwise, if two calls with different cache keys
  // overlap, call A's closure could null B's in-flight build (causing a
  // redundant rebuild) or overwrite the cache with A's stale key/provider
  // (finding: concurrent provider builds corrupt shared pendingProvider/
  // cachedProvider state).
  const p = buildProvider(config).then((provider) => {
    cachedProvider = provider;
    cachedConfigKey = key;
    if (pendingProvider === p) {
      pendingProvider = null;
      pendingProviderKey = null;
    }
    return provider;
  }).catch((e) => {
    if (pendingProvider === p) {
      pendingProvider = null;
      pendingProviderKey = null;
    }
    throw e;
  });
  pendingProvider = p;
  return p;
}

/**
 * One navigator step — DIRECT call to the LLM provider (no localhost).
 *
 * Mirrors what the Next.js `/api/agent/navigator` route did, but runs entirely
 * in the extension's background worker.
 *
 * @returns `{ raw, tokensIn, tokensOut, model }` — same shape the orchestrator
 *          expects from `navigatorCall`.
 * @throws on provider errors, parse failures (caller surfaces to the
 *         orchestrator's parse-retry loop; transient HTTP errors are retried
 *         inside `withLLMRetry` at the transport layer).
 */
export async function navigatorCallDirect(req: AgentStepRequest): Promise<{
  raw: string;
  tokensIn?: number;
  tokensOut?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  model?: string;
  costUsd?: number;
}> {
  // Cap elementsText (same abuse-prevention as the Next.js route).
  const cappedElementsText =
    req.browserState.elementsText.length > MAX_ELEMENTS_CHARS
      ? req.browserState.elementsText.slice(0, MAX_ELEMENTS_CHARS) +
        `\n[... truncated at ${MAX_ELEMENTS_CHARS} chars ...]`
      : req.browserState.elementsText;

  const userMessage = await buildNavigatorUserMessage({
    task: req.task,
    history: req.history,
    currentGoal: req.currentGoal || req.task,
    plan: req.plan,
    currentPlanItem: req.currentPlanItem,
    browserState: { ...req.browserState, elementsText: cappedElementsText, axTree: req.browserState.axTree },
    step: req.step,
    maxSteps: req.maxSteps,
    // pass the compacted-memory block so it's rendered in the prompt.
    compactedMemory: req.compactedMemory,
  });

  // load custom navigator prompt override (cached, invalidated on storage change).
  const customNavigatorPrompt = await getCustomNavigatorPrompt();
  const visionMode = await getVisionMode();
  let systemPrompt = buildNavigatorPrompt(MAX_ACTIONS, customNavigatorPrompt, visionMode);
  const provider = await getProvider();

  // Embed screenshot marker ONLY for vision-capable models. Text-only models
  // would either error (HTTP 400 from the API) or waste tokens processing a
  // giant base64 string they can't interpret. The `provider.supportsVision`
  // flag is set per-MODEL via the models.dev catalog lookup in buildProvider().
  // Also check the user's "enableScreenshots" setting (defaults to true for
  // vision models, false for text-only models).
  const enableScreenshots = provider.supportsVision &&
    ((await chrome.storage.local.get("enableScreenshots")).enableScreenshots ?? true);
  const screenshot = enableScreenshots ? req.browserState.screenshot : undefined;
  const fullUserContent = screenshot
    ? `${userMessage}\n\n<screenshot>${screenshot}</screenshot>`
    : userMessage;

  // Wire `getFormatInstructions` for providers that don't support structured
  // output natively (Ollama, OpenAI-compatible providers without
  // `response_format`, local models). Without the schema inlined into the
  // system prompt, those providers can only guess the JSON shape from the
  // prompt examples — inlining the canonical JSON schema (via Zod 4's
  // `z.toJSONSchema`) gives the model a concrete contract to emit. The
  // format-instructions text is short and provider-agnostic.
  if (!provider.supportsStructuredOutput) {
    systemPrompt += "\n\n" + getFormatInstructions(AgentOutputSchema);
  }

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: fullUserContent },
  ];

  const response = await provider.chat({
    messages,
    temperature: 0,
    schema: provider.supportsStructuredOutput ? AgentOutputSchema : undefined,
  });

  // The orchestrator re-parses `raw` itself, so we just return the raw content.
  // Return cachedInputTokens + the provider-bridge's pre-computed costUsd
  // (which correctly accounts for cached tokens). Dropping these here would
  // force llm-calls.ts to recompute cost via estimateCost WITHOUT
  // cachedInputTokens — under-reporting Anthropic cached-step cost by up to
  // 90% and effectively disabling cost-cap enforcement for cached calls.
  return {
    raw: response.content,
    tokensIn: response.usage?.tokensIn,
    tokensOut: response.usage?.tokensOut,
    reasoningTokens: response.usage?.reasoningTokens,
    cachedInputTokens: response.usage?.cachedInputTokens,
    model: response.usage?.model,
    costUsd: response.usage?.costUsd,
  };
}

/**
 * One planner step — DIRECT call to the LLM provider (no localhost).
 *
 * Mirrors what the Next.js `/api/agent/planner` route did, but runs entirely
 * in the extension's background worker.
 *
 * @returns `{ raw, tokensIn, tokensOut, model }` — same shape the orchestrator
 *          expects from `plannerCall`.
 */
export async function plannerCallDirect(req: PlannerStepRequest): Promise<{
  raw: string;
  tokensIn?: number;
  tokensOut?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  model?: string;
  costUsd?: number;
}> {
  const userMessage = buildPlannerUserMessage({
    task: req.task,
    navigatorHistory: req.history,
    plan: req.plan,
    currentPlanItem: req.currentPlanItem,
    url: req.url,
    tabs: req.tabs,
    step: req.step,
    maxSteps: req.maxSteps,
  });

  // load custom planner prompt override (cached, invalidated on storage change).
  const customPlannerPrompt = await getCustomPlannerPrompt();
  let systemPrompt = buildPlannerPrompt(customPlannerPrompt);
  const provider = await getProvider();

  // Wire `getFormatInstructions` for providers without native structured
  // output. Symmetric with the navigator path above — without the JSON schema
  // inlined, non-structured-output providers may emit free-form text that
  // fails the planner parser. Inlining the schema gives the model a concrete
  // contract for the planner's `{thinking, decision, success, ...}` shape.
  if (!provider.supportsStructuredOutput) {
    systemPrompt += "\n\n" + getFormatInstructions(PlannerOutputSchema);
  }

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  const response = await provider.chat({
    messages,
    temperature: 0,
    schema: provider.supportsStructuredOutput ? PlannerOutputSchema : undefined,
  });

  // Return cachedInputTokens + pre-computed costUsd (see navigatorCallDirect).
  return {
    raw: response.content,
    tokensIn: response.usage?.tokensIn,
    tokensOut: response.usage?.tokensOut,
    reasoningTokens: response.usage?.reasoningTokens,
    cachedInputTokens: response.usage?.cachedInputTokens,
    model: response.usage?.model,
    costUsd: response.usage?.costUsd,
  };
}
