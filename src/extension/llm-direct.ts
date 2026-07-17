/**
 * Direct LLM calls — builds the navigator/planner messages and calls the LLM
 * provider directly. Used by the Chrome extension's background worker.
 *
 * The extension:
 * 1. Builds the system + user messages.
 * 2. Resolves the provider from `chrome.storage.local` config.
 * 3. Calls `provider.chat()` directly (the provider uses `fetch` to the LLM
 * API, which works because the extension has `host_permissions:
 * ["<all_urls>"]`).
 * 4. Parses the output.
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
import { buildProvider, readProviderConfig, type ProviderConfig } from "./provider-config";
import { MAX_ACTIONS, MAX_ELEMENTS_CHARS } from "@/lib/validations";

/** Cached provider instance + the config it was built from (rebuilt on config change). */
let cachedProvider: LLMProvider | null = null;
let cachedConfigKey: string | null = null;
/** The full config object backing `cachedProvider` (used for the hot-path short-circuit). */
let cachedProviderConfig: ProviderConfig | null = null;
/** In-flight build promises keyed by cache key — prevents double-building when
 * concurrent calls (even with different keys) race. */
const pendingProviders = new Map<string, Promise<LLMProvider>>();
/** Monotonic config epoch, bumped whenever a provider-config key changes. A
 * build captures the epoch at start and only commits to the cache if it is
 * still current, so a superseded in-flight build cannot resurrect a stale
 * provider after an invalidation. */
let configEpoch = 0;

// Cached settings (invalidated on chrome.storage.onChanged via the listener
// below). A single Map backs every cached setting so the per-key invalidation
// is the only place that touches the cache and the four getters share one
// memoization path instead of four copy-pasted cache variables.
const settingCache = new Map<string, unknown>();

/** Provider-config storage keys whose change must invalidate the cached provider. */
const PROVIDER_CONFIG_KEYS = ["provider", "model", "baseUrl", "resourceName", "apiKey", "provenance"];

if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, _area) => {
    if (PROVIDER_CONFIG_KEYS.some((k) => k in changes)) {
      cachedProvider = null;
      cachedConfigKey = null;
      cachedProviderConfig = null;
      configEpoch++;
    }
    if (changes.customNavigatorPrompt) settingCache.delete("customNavigatorPrompt");
    if (changes.customPlannerPrompt) settingCache.delete("customPlannerPrompt");
    if (changes.visionMode || changes.enableLocalVision) settingCache.delete("visionMode");
    if (changes.enableScreenshots) settingCache.delete("enableScreenshots");
    if (changes.agentMode) settingCache.delete("agentMode");
  });
}

const VISION_MODES = new Set(["disabled", "always", "adaptive"]);

async function getCustomNavigatorPrompt(): Promise<string | undefined> {
  if (settingCache.has("customNavigatorPrompt")) {
    return (settingCache.get("customNavigatorPrompt") as string | undefined) ?? undefined;
  }
  const { customNavigatorPrompt } = await chrome.storage.local.get("customNavigatorPrompt");
  settingCache.set("customNavigatorPrompt", customNavigatorPrompt);
  return (customNavigatorPrompt as string | undefined) ?? undefined;
}

async function getCustomPlannerPrompt(): Promise<string | undefined> {
  if (settingCache.has("customPlannerPrompt")) {
    return (settingCache.get("customPlannerPrompt") as string | undefined) ?? undefined;
  }
  const { customPlannerPrompt } = await chrome.storage.local.get("customPlannerPrompt");
  settingCache.set("customPlannerPrompt", customPlannerPrompt);
  return (customPlannerPrompt as string | undefined) ?? undefined;
}

export async function getVisionMode(): Promise<"disabled" | "always" | "adaptive"> {
  if (settingCache.has("visionMode")) {
    return settingCache.get("visionMode") as "disabled" | "always" | "adaptive";
  }
 // `visionMode` is the single source of truth (disabled | always | adaptive).
 // `enableLocalVision` is a legacy key kept only for one-time backward
 // compatibility: if `visionMode` is unset but `enableLocalVision` was true,
 // treat it as "always". New code should only ever write `visionMode`.
  const { visionMode, enableLocalVision } = await chrome.storage.local.get([
    "visionMode",
    "enableLocalVision",
  ]);
  const mode = VISION_MODES.has(visionMode as string)
    ? (visionMode as "disabled" | "always" | "adaptive")
    : (enableLocalVision === true ? "always" : "disabled");
  settingCache.set("visionMode", mode);
  return mode;
}

/** Cached `enableScreenshots` setting (defaults to true). */
async function getEnableScreenshots(): Promise<boolean> {
  if (settingCache.has("enableScreenshots")) {
    return settingCache.get("enableScreenshots") as boolean;
  }
  const { enableScreenshots } = await chrome.storage.local.get("enableScreenshots");
  const value = (enableScreenshots as boolean | undefined) ?? true;
  settingCache.set("enableScreenshots", value);
  return value;
}

/** Map a provider chat response's `content`/`usage` to the shape the
 * orchestrator expects from `navigatorCall`/`plannerCall`. */
function extractUsage(r: {
  content: string;
  usage?: {
    tokensIn?: number;
    tokensOut?: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
    model?: string;
    costUsd?: number;
  };
}) {
  return {
    raw: r.content,
    tokensIn: r.usage?.tokensIn,
    tokensOut: r.usage?.tokensOut,
    reasoningTokens: r.usage?.reasoningTokens,
    cachedInputTokens: r.usage?.cachedInputTokens,
    model: r.usage?.model,
    costUsd: r.usage?.costUsd,
  };
}

/**
 * Resolve the active agent mode (full_agentic | standard | restricted) for the
 * run. Used so `buildNavigatorPrompt` can describe `evaluate`'s availability
 * accurately (confirmation-gated outside full_agentic mode). Falls back to
 * "standard" if unset or unrecognized so a corrupt/legacy `agentMode` value in
 * chrome.storage can never crash prompt construction or put the navigator into
 * an undefined mode.
 */
const AGENT_MODES = new Set(["full_agentic", "standard", "restricted"]);
export async function getAgentMode(): Promise<string> {
  if (settingCache.has("agentMode")) {
    return settingCache.get("agentMode") as string;
  }
  const { agentMode } = await chrome.storage.local.get(["agentMode"]);
  const mode = agentMode as string | undefined;
  const resolved = mode && AGENT_MODES.has(mode) ? mode : "standard";
  settingCache.set("agentMode", resolved);
  return resolved;
}

/**
 * Cheap, non-reversible digest of a secret (e.g. an API key) for use inside a
 * cache key. The key material is never persisted as plaintext — only this short
 * digest survives in the long-lived `cachedConfigKey` string — while cache
 * invalidation still fires whenever the secret changes.
 */
export function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Resolve the LLM provider from stored config, caching the instance until the
 * config changes. An in-flight promise prevents double-building when concurrent
 * calls race. Throws if no provider is configured.
 */
async function getProvider(): Promise<LLMProvider> {
 // Hot path: reuse the cached provider WITHOUT a storage round-trip. The cache
 // is invalidated by the `chrome.storage.onChanged` listener above whenever a
 // provider-config key changes, so this short-circuit is safe and avoids an
 // async `chrome.storage.local.get` on every navigator/planner step.
  if (cachedProvider && cachedProviderConfig) return cachedProvider;
  const config = await readProviderConfig();
  if (!config) {
    throw new Error(
      "No LLM provider configured. Open the extension Options page, choose a provider, and enter your API key."
    );
  }
 // Cache key: provider + apiKey + model + baseUrl + resourceName. If any
 // change, rebuild. `resourceName` is included so an Azure resource swap
 // (which changes the constructed endpoint) forces a provider rebuild rather
 // than reusing a stale cached instance bound to the old resource. Use a
 // JSON-encoded tuple so user-controlled fields containing the `|` separator
 // cannot collide and produce a wrong-provider key.
  const key = JSON.stringify([
    config.provider,
    hashStr(config.apiKey ?? ""),
    config.model,
    config.baseUrl ?? null,
    config.resourceName ?? null,
  ]);
  cachedProviderConfig = config;
  if (cachedProvider && key === cachedConfigKey) return cachedProvider;
 // If a build is already in-flight for THIS key, await it instead of
 // starting a second concurrent buildProvider() call.
  const existing = pendingProviders.get(key);
  if (existing) return existing;
 // Capture the in-flight promise locally so its resolve/reject closures only
 // clear the entry for THIS key. Otherwise, if two calls with different cache
 // keys overlap, call A's closure could null B's in-flight build (causing a
 // redundant rebuild) or overwrite the cache with A's stale key/provider
 // (finding: concurrent provider builds corrupt shared pendingProvider/
 // cachedProvider state).
  const epochAtBuild = configEpoch;
  const p = buildProvider(config).then((provider) => {
    pendingProviders.delete(key);
   // Only commit if no config change happened while this build was in flight.
   // A superseded build must not resurrect a stale provider/key.
    if (configEpoch === epochAtBuild) {
      cachedProvider = provider;
      cachedConfigKey = key;
      cachedProviderConfig = config;
    }
    return provider;
  }).catch((e) => {
    pendingProviders.delete(key);
    throw e;
  });
  pendingProviders.set(key, p);
  return p;
}

/**
 * Cap `text` to `max` characters, appending a marker so the model knows data
 * was dropped. Guards `undefined` (treated as empty) so a missing field can
 * never throw on `.length`. Used for both elementsText and axTree.
 */
export function capText(text: string | undefined, max: number): string {
  const safe = text ?? "";
  return safe.length > max
    ? safe.slice(0, max) + `\n[... truncated at ${max} chars ...]`
    : safe;
}

/**
 * One navigator step — direct call to the LLM provider. Returns
 * `{ raw, tokensIn, tokensOut, model, ... }` — the shape the orchestrator
 * expects from `navigatorCall`.
 */
export async function navigatorCallDirect(
  req: AgentStepRequest,
  signal?: AbortSignal,
): Promise<{
  raw: string;
  tokensIn?: number;
  tokensOut?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  model?: string;
  costUsd?: number;
}> {
 // Cap elementsText (same abuse-prevention as the Next.js route).
  const cappedElementsText = capText(req.browserState.elementsText, MAX_ELEMENTS_CHARS);

 // Cap axTree symmetrically to elementsText. On large pages the AX tree can be
 // very large and is re-sent on every navigator step; leaving it uncapped both
 // inflates per-step input tokens and risks message-size limits. The truncation
 // marker tells the model data was dropped.
  const cappedAxTree = capText(req.browserState.axTree, MAX_ELEMENTS_CHARS);

  const userMessage = await buildNavigatorUserMessage({
    task: req.task,
    history: req.history,
    currentGoal: req.currentGoal || req.task,
    plan: req.plan,
    currentPlanItem: req.currentPlanItem,
    browserState: { ...req.browserState, elementsText: cappedElementsText, axTree: cappedAxTree },
    step: req.step,
    maxSteps: req.maxSteps,
 // pass the compacted-memory block so it's rendered in the prompt.
    compactedMemory: req.compactedMemory,
  });

 // load custom navigator prompt override (cached, invalidated on storage change).
 // These four reads are independent — fetch them in parallel so a cache miss
 // doesn't serialize 3-4 extra chrome.storage.local.get round-trips per step.
  const [customNavigatorPrompt, visionMode, agentMode, provider] = await Promise.all([
    getCustomNavigatorPrompt(),
    getVisionMode(),
    getAgentMode(),
    getProvider(),
  ]);
  let systemPrompt = buildNavigatorPrompt(MAX_ACTIONS, customNavigatorPrompt, visionMode, agentMode);

 // Embed screenshot marker ONLY for vision-capable models. Text-only models
 // would either error (HTTP 400 from the API) or waste tokens processing a
 // giant base64 string they can't interpret. The `provider.supportsVision`
 // flag is set per-MODEL via the models.dev catalog lookup in buildProvider().
 // Also check the user's "enableScreenshots" setting (defaults to true for
 // vision models, false for text-only models).
  const enableScreenshots = provider.supportsVision && (await getEnableScreenshots());
  const screenshot = enableScreenshots ? req.browserState.screenshot : undefined;
 // The screenshot is raw, page-rendered pixels — it is NOT subject to the text
 // sanitizer (which only inspects DOM/AX text) and must be treated as untrusted
 // page data, exactly like <untrusted_page_data>. The navigator prompt already
 // tells the model the screenshot is untrusted evidence, never an instruction.
 //
 // Each navigator step is a stateless, two-message call with no prior image
 // retained in the outgoing messages, so the screenshot must be sent on every
 // step. Eliding an unchanged screenshot would leave the vision model with zero
 // pixels and a note referencing an image it was never shown. The screenshot
 // stays inside the untrusted wrapper exactly as before.
  const fullUserContent = screenshot
    ? `${userMessage}\n\n<untrusted_page_data><screenshot>${screenshot}</screenshot></untrusted_page_data>`
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
    ...(provider.supportsReasoning ? {} : { temperature: 0 }),
    schema: provider.supportsStructuredOutput ? AgentOutputSchema : undefined,
    ...(signal ? { signal } : {}),
  });

 // The orchestrator re-parses `raw` itself, so we just return the raw content.
 // Return cachedInputTokens + the provider-bridge's pre-computed costUsd
 // (which correctly accounts for cached tokens). Dropping these here would
 // force llm-calls.ts to recompute cost via estimateCost WITHOUT
 // cachedInputTokens — under-reporting Anthropic cached-step cost by up to
 // 90% and effectively disabling cost-cap enforcement for cached calls.
  return extractUsage(response);
}

/**
 * One planner step — direct call to the LLM provider. Returns
 * `{ raw, tokensIn, tokensOut, model, ... }` — the shape the orchestrator
 * expects from `plannerCall`.
 */
export async function plannerCallDirect(
  req: PlannerStepRequest,
  signal?: AbortSignal,
): Promise<{
  raw: string;
  tokensIn?: number;
  tokensOut?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  model?: string;
  costUsd?: number;
}> {
  const userMessage = await buildPlannerUserMessage({
    task: req.task,
    navigatorHistory: req.history,
    plan: req.plan,
    currentPlanItem: req.currentPlanItem,
    url: req.url,
    tabs: req.tabs,
    step: req.step,
    maxSteps: req.maxSteps,
    compactedMemory: req.compactedMemory,
  });

 // load custom planner prompt override (cached, invalidated on storage change).
 // Planner prompt + provider are independent reads — fetch them in parallel.
  const [customPlannerPrompt, provider] = await Promise.all([
    getCustomPlannerPrompt(),
    getProvider(),
  ]);
  let systemPrompt = buildPlannerPrompt(customPlannerPrompt);

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
    ...(provider.supportsReasoning ? {} : { temperature: 0 }),
    schema: provider.supportsStructuredOutput ? PlannerOutputSchema : undefined,
    ...(signal ? { signal } : {}),
  });

 // Return cachedInputTokens + pre-computed costUsd (see navigatorCallDirect).
  return extractUsage(response);
}
