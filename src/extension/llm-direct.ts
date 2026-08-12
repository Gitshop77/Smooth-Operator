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

import type { LLMProvider, LLMRequest, LLMResponse, ChatMessage } from "../lib/agent/llm/provider";
import {
  compileNavigatorPromptV1,
  compilePlannerPromptV1,
} from "../lib/agent/prompts/prompt-compiler";
import { assertCompiledPromptWithinProfileV1 } from "../lib/agent/prompts/prompt-token-budget";
import { AgentOutputSchema, PlannerOutputSchema } from "../lib/agent/tools/schema";
import { getFormatInstructions } from "../lib/agent/tools/registry";
import type { AgentStepRequest, PlannerStepRequest, TokenUsage } from "../lib/agent/types";
import { primeLiveSecretRedaction } from "../lib/agent/secrets";
import { buildProvider, readProviderConfig, resolveModel, type ProviderConfig } from "./provider-config";
import { CATALOG_PROVIDER_ID_MAP } from "./provider-config-map";
import { getModelsForProvider } from "../lib/agent/llm/catalog";
import {
  LLMTerminalDiagnosticError,
  type LLMTerminalDiagnostic,
} from "../lib/agent/llm/route/client";
import { MAX_ACTIONS, MAX_ELEMENTS_CHARS } from "@/lib/validations";
import {
  extractUsage,
  capText,
  stripScreenshotMarkers,
  stripHistoryScreenshotMarkers,
} from "./llm-direct-utils";

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

/** Models already surfaced with an experimental-release warning (once per session). */
const warnedExperimentalModels = new Set<string>();

/** Race a caller-owned wait without cancelling the shared provider build. */
export function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason instanceof Error
        ? signal.reason
        : new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

/** Bound the warned-set growth, mirroring the pricing fallback warning. */
function maybeClearWarnedExperimentalModels(): void {
  if (warnedExperimentalModels.size > 32) warnedExperimentalModels.clear();
}

/**
 * One-time console warning when a DIRECT call runs with an alpha/beta
 * (experimental) catalog model. Default resolution never selects experimental
 * models, so reaching this code means the user opted in explicitly — worth
 * surfacing once, since the release can change or disappear without notice.
 */
function warnExperimentalModelOnce(providerId: string, modelId: string): void {
  if (!providerId || !modelId) return;
  const status = getModelsForProvider(
    CATALOG_PROVIDER_ID_MAP[providerId] ?? providerId,
    modelId,
  )?.status;
  if (status !== "alpha" && status !== "beta") return;
  if (warnedExperimentalModels.has(modelId)) return;
  maybeClearWarnedExperimentalModels();
  warnedExperimentalModels.add(modelId);
  console.warn(
    `[llm-direct] Model "${modelId}" is an ${status} (experimental) release — ` +
      `it may change or disappear without notice.`
  );
}

// Cached settings (invalidated on chrome.storage.onChanged via the listener
// below). A single Map backs every cached setting so the per-key invalidation
// is the only place that touches the cache; `cachedSetting` gives every getter
// the same memoization path instead of copy-pasted cache variables.
const settingCache = new Map<string, unknown>();

/** Provider-config storage keys whose change must invalidate the cached provider. */
const PROVIDER_CONFIG_KEYS = ["provider", "model", "baseUrl", "resourceName", "apiKey", "provenance"];

if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, _area) => {
    // `forceReasoning` is read by buildProvider to patch supportsReasoning, so
    // a change must invalidate the cached provider — not just the setting.
    if (
      PROVIDER_CONFIG_KEYS.some((k) => k in changes) ||
      changes.forceReasoning
    ) {
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
    if (changes.reasoningEffort) settingCache.delete("reasoningEffort");
    if (changes.reasoningBudget) settingCache.delete("reasoningBudget");
    if (changes.forceReasoning) settingCache.delete("forceReasoning");
  });
}

const VISION_MODES = new Set(["disabled", "always", "adaptive"]);

/** Memoized getter for a chrome.storage.local setting; `read` computes on miss. */
function cachedSetting<T>(key: string, read: () => Promise<T>): () => Promise<T> {
  return async () => {
    if (settingCache.has(key)) return settingCache.get(key) as T;
    const value = await read();
    settingCache.set(key, value);
    return value;
  };
}

const getCustomNavigatorPrompt = cachedSetting("customNavigatorPrompt", async () => {
  const { customNavigatorPrompt } = await chrome.storage.local.get("customNavigatorPrompt");
  return (customNavigatorPrompt as string | undefined) ?? undefined;
});

const getCustomPlannerPrompt = cachedSetting("customPlannerPrompt", async () => {
  const { customPlannerPrompt } = await chrome.storage.local.get("customPlannerPrompt");
  return (customPlannerPrompt as string | undefined) ?? undefined;
});

export const getVisionMode = cachedSetting("visionMode", async () => {
 // `visionMode` is the single source of truth (disabled | always | adaptive).
 // `enableLocalVision` is a legacy key kept only for one-time backward
 // compatibility: if `visionMode` is unset but `enableLocalVision` was true,
 // treat it as "always". New code should only ever write `visionMode`.
  const { visionMode, enableLocalVision } = await chrome.storage.local.get([
    "visionMode",
    "enableLocalVision",
  ]);
  return VISION_MODES.has(visionMode as string)
    ? (visionMode as "disabled" | "always" | "adaptive")
    : (enableLocalVision === true ? "always" : "disabled");
});

/** Cached `enableScreenshots` setting (defaults to true). */
const getEnableScreenshots = cachedSetting("enableScreenshots", async () => {
  const { enableScreenshots } = await chrome.storage.local.get("enableScreenshots");
  return (enableScreenshots as boolean | undefined) ?? true;
});

/**
 * Resolve the active agent mode (full_agentic | standard | restricted) for the
 * run. Used so `buildNavigatorPrompt` can describe `evaluate`'s availability
 * accurately (confirmation-gated outside full_agentic mode). Falls back to
 * "standard" if unset or unrecognized so a corrupt/legacy `agentMode` value in
 * chrome.storage can never crash prompt construction or put the navigator into
 * an undefined mode.
 */
const AGENT_MODES = new Set(["full_agentic", "standard", "restricted"]);
export const getAgentMode = cachedSetting("agentMode", async () => {
  const { agentMode } = await chrome.storage.local.get(["agentMode"]);
  const mode = agentMode as string | undefined;
  return mode && AGENT_MODES.has(mode) ? mode : "standard";
});

/** Recognized reasoning-effort levels (release-date-agnostic first cut — no
 * "none"/"xhigh" yet, so pre-cutoff models never 400 on an unsupported value). */
const REASONING_EFFORTS = new Set(["low", "medium", "high"]);

/** Memoized `reasoningEffort` setting ("low" | "medium" | "high"). */
export const getReasoningEffort = cachedSetting("reasoningEffort", async () => {
  const { reasoningEffort } = await chrome.storage.local.get("reasoningEffort");
  const v = reasoningEffort as string | undefined;
  return v && REASONING_EFFORTS.has(v) ? v : undefined;
});

/** Memoized `reasoningBudget` setting (positive integer thinking-budget tokens). */
export const getReasoningBudget = cachedSetting("reasoningBudget", async () => {
  const { reasoningBudget } = await chrome.storage.local.get("reasoningBudget");
  return typeof reasoningBudget === "number" &&
    Number.isFinite(reasoningBudget) &&
    reasoningBudget > 0
    ? Math.floor(reasoningBudget)
    : undefined;
});

/** Recognized forceReasoning values: "on" forces reasoning params even for
 * models the catalog doesn't flag; "off" suppresses them; "auto" keeps the
 * catalog-derived flag. */
const REASONING_FORCE = new Set(["on", "off", "auto"]);

/** Memoized `forceReasoning` setting ("on" | "off" | "auto"). */
export const getForceReasoning = cachedSetting("forceReasoning", async () => {
  const { forceReasoning } = await chrome.storage.local.get("forceReasoning");
  const v = forceReasoning as string | undefined;
  return v && REASONING_FORCE.has(v) ? v : undefined;
});

/**
 * Resolve the user's reasoning configuration into the `LLMRequest.reasoning`
 * shape (effort / budget / force), or undefined when nothing is configured.
 * "auto"/unset force produces an empty override so the provider's own
 * reasoning support decides.
 */
async function resolveReasoningConfig(): Promise<LLMRequest["reasoning"]> {
  const [effort, budgetTokens, forceReasoning] = await Promise.all([
    getReasoningEffort(),
    getReasoningBudget(),
    getForceReasoning(),
  ]);
  if (!effort && budgetTokens === undefined && !forceReasoning) return undefined;
  return {
    ...(effort ? { effort } : {}),
    ...(budgetTokens !== undefined ? { budgetTokens } : {}),
    ...(forceReasoning === "on"
      ? { enabled: true }
      : forceReasoning === "off"
        ? { enabled: false }
        : {}),
  };
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
  // Provider errors are surfaced through live run events. Prime the
  // synchronous exact-value redactor with the selected key before any route
  // can construct a non-2xx diagnostic; this cache remains memory-only.
  await primeLiveSecretRedaction(config.apiKey);
 // Cache key: provider + apiKey + model + baseUrl + resourceName. If any
 // change, rebuild. `resourceName` is included so an Azure resource swap
 // (which changes the constructed endpoint) forces a provider rebuild rather
 // than reusing a stale cached instance bound to the old resource. Use a
 // JSON-encoded tuple so user-controlled fields containing the `|` separator
 // cannot collide and produce a wrong-provider key.
 // Use the raw apiKey (not a 32-bit djb2 hash) in the cache key. A non-crypto
 // hash can collide for distinct keys, silently reusing a stale provider and
 // leaking one tenant's credentials/config into another's request. The JSON
 // tuple already quoted user-controlled fields so the `|` separator can't
 // collide, so the raw key is safe here.
  const key = JSON.stringify([
    config.provider,
    config.apiKey ?? null,
    config.model,
    config.baseUrl ?? null,
    config.resourceName ?? null,
  ]);
  if (cachedProvider && key === cachedConfigKey) return cachedProvider;
 // If a build is already in-flight for THIS key, await it instead of
 // starting a second concurrent buildProvider() call.
  const existing = pendingProviders.get(key);
  if (existing) return existing;
 // Capture the in-flight promise locally so its resolve/reject closures only
 // clear the entry for THIS key. Otherwise, if two calls with different cache
 // keys overlap, call A's closure could null B's in-flight build (causing a
 // redundant rebuild) or overwrite the cache with A's stale key/provider
  // (concurrent provider builds could corrupt the shared pendingProvider/
  // cachedProvider state).
  const epochAtBuild = configEpoch;
  const p = buildProvider(config).then((provider) => {
    pendingProviders.delete(key);
    // Experimental (alpha/beta) models are never defaulted to, so reaching a
    // direct call with one is an explicit opt-in worth warning about — once.
    // Resolve the model with the same shared helper buildProvider uses so the
    // warning names the model actually called.
    warnExperimentalModelOnce(
      config.provider,
      resolveModel({
        provider: config.provider,
        model: config.model,
        catalogId: CATALOG_PROVIDER_ID_MAP[config.provider] ?? config.provider,
      }),
    );
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

/** Shape the orchestrator expects from `navigatorCall` / `plannerCall`. */
interface DirectCallResult {
  raw: string;
  tokensIn?: number;
  tokensOut?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cachedWriteInputTokens?: number;
  model?: string;
  costUsd?: number;
}

/**
 * Direct agent calls require a visible, parseable completion. The lower route
 * layer keeps its response-content contract compatible and attaches an additive
 * diagnosis; this boundary turns that outcome into a typed actionable failure
 * before the loop can mislabel it as ordinary malformed JSON.
 */
function requireDirectVisibleOutput(response: LLMResponse): void {
  const diagnostic = (response as LLMResponse & {
    terminalDiagnostic?: LLMTerminalDiagnostic;
  }).terminalDiagnostic;
  if (diagnostic) {
    const error = new LLMTerminalDiagnosticError(diagnostic);
    error.usage = extractUsage(response);
    throw error;
  }
  if (response.content.trim().length === 0) {
    const error = new LLMTerminalDiagnosticError({
      code: "empty_visible_output",
      protocol: "provider",
      visibleContentChars: response.content.length,
      terminalSeen: true,
    });
    error.usage = extractUsage(response);
    throw error;
  }
}

/**
 * One navigator step — direct call to the LLM provider. Returns
 * `{ raw, tokensIn, tokensOut, model, ... }` — the shape the orchestrator
 * expects from `navigatorCall`.
 */
export async function navigatorCallDirect(
  req: AgentStepRequest,
  signal?: AbortSignal,
): Promise<DirectCallResult> {
 // Cap elementsText (same abuse-prevention as the Next.js route).
 // Strip any `<screenshot>…</screenshot>` markers from the UNTRUSTED page text
 // BEFORE it is composed into the model input — see `stripScreenshotMarkers`.
 // The real screenshot is injected later from `req.browserState.screenshot`, so
 // this only removes forged markers a malicious page could have embedded.
  const cappedElementsText = stripScreenshotMarkers(
    capText(req.browserState.elementsText, MAX_ELEMENTS_CHARS),
  );

 // Cap axTree symmetrically to elementsText. On large pages the AX tree can be
 // very large and is re-sent on every navigator step; leaving it uncapped both
 // inflates per-step input tokens and risks message-size limits. The truncation
 // marker tells the model data was dropped. Also strip forged screenshot markers.
  const cappedAxTree = stripScreenshotMarkers(
    capText(req.browserState.axTree, MAX_ELEMENTS_CHARS),
  );

 // History can carry page-derived content (extract results, summaries of a
 // malicious page) — strip any injected `<screenshot>` markers before render.
  const strippedHistory = stripHistoryScreenshotMarkers(req.history);

  const navigatorUser = {
    task: req.task,
    history: strippedHistory,
    currentGoal: req.currentGoal || req.task,
    plan: req.plan,
    currentPlanItem: req.currentPlanItem,
    browserState: { ...req.browserState, elementsText: cappedElementsText, axTree: cappedAxTree },
    step: req.step,
    maxSteps: req.maxSteps,
 // pass the compacted-memory block so it's rendered in the prompt.
    compactedMemory: req.compactedMemory,
 // pass the loop-warning block (budget/replan/loop nudges, parse-error
 // retry feedback) so the navigator actually sees it.
    loopWarning: req.loopWarning,
  };

 // load custom navigator prompt override (cached, invalidated on storage change).
 // These reads are independent — fetch them in parallel so a cache miss
 // doesn't serialize extra chrome.storage.local.get round-trips per step.
  const [customNavigatorPrompt, visionMode, agentMode, reasoningConfig, provider] = await Promise.all([
    getCustomNavigatorPrompt(),
    getVisionMode(),
    getAgentMode(),
    resolveReasoningConfig(),
    raceWithAbort(getProvider(), signal),
  ]);
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
 // Wire `getFormatInstructions` for providers that don't support structured
 // output natively (Ollama, OpenAI-compatible providers without
 // `response_format`, local models). Without the schema inlined into the
 // system prompt, those providers can only guess the JSON shape from the
 // prompt examples — inlining the canonical JSON schema (via Zod 4's
 // `z.toJSONSchema`) gives the model a concrete contract to emit. The
 // format-instructions text is short and provider-agnostic.
  const compiled = await compileNavigatorPromptV1({
    maxActions: MAX_ACTIONS,
    customPrompt: customNavigatorPrompt,
    visionMode,
    mode: agentMode,
    user: navigatorUser,
    systemSuffix: provider.supportsStructuredOutput
      ? ""
      : "\n\n" + getFormatInstructions(AgentOutputSchema),
    userSuffix: screenshot
      ? `\n\n<untrusted_page_data><screenshot>${screenshot}</screenshot></untrusted_page_data>`
      : "",
  });
  const messages: ChatMessage[] = compiled.messages;
  // Budget guard: the fully assembled navigator prompt (system + user,
  // including the injected screenshot marker and format instructions) must fit
  // the navigator profile's conservative UTF-8-byte input budget before any
  // tokens are spent. Failing closed here prevents an unbounded DOM/screenshot
  // payload from ever crossing the network, even if every earlier cap is
  // misconfigured.
  assertCompiledPromptWithinProfileV1("navigator", "navigator", messages);

  const response = await provider.chat({
    messages,
    ...(provider.supportsReasoning ? {} : { temperature: 0 }),
    ...(reasoningConfig ? { reasoning: reasoningConfig } : {}),
    // Navigator steps reuse this exact system prompt across steps, so a
    // cache write is actually re-read — keep the Anthropic "1h" cache marker.
    ...(compiled.cache.cacheEligible ? { cacheEligible: compiled.cache.cacheEligible } : {}),
    schema: provider.supportsStructuredOutput ? AgentOutputSchema : undefined,
    ...(signal ? { signal } : {}),
  });

  requireDirectVisibleOutput(response);

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
): Promise<DirectCallResult> {
 // History can carry page-derived content (extract results, summaries of a
 // malicious page) — strip any injected `<screenshot>` markers before render,
 // mirroring the navigator path's defense against page-injected image attachment.
  const strippedHistory = stripHistoryScreenshotMarkers(req.history);
  const plannerUser = {
    task: req.task,
    navigatorHistory: strippedHistory,
    plan: req.plan,
    currentPlanItem: req.currentPlanItem,
    url: req.url,
    tabs: req.tabs,
    step: req.step,
    maxSteps: req.maxSteps,
    compactedMemory: req.compactedMemory,
  };

 // load custom planner prompt override (cached, invalidated on storage change).
 // Planner prompt + reasoning config + provider are independent reads — fetch
 // them in parallel.
  const [customPlannerPrompt, reasoningConfig, provider] = await Promise.all([
    getCustomPlannerPrompt(),
    resolveReasoningConfig(),
    raceWithAbort(getProvider(), signal),
  ]);
 // Wire `getFormatInstructions` for providers without native structured
 // output. Symmetric with the navigator path above — without the JSON schema
 // inlined, non-structured-output providers may emit free-form text that
 // fails the planner parser. Inlining the schema gives the model a concrete
 // contract for the planner's `{thinking, decision, success, ...}` shape.
  const compiled = await compilePlannerPromptV1({
    customPrompt: customPlannerPrompt,
    user: plannerUser,
    systemSuffix: provider.supportsStructuredOutput
      ? ""
      : "\n\n" + getFormatInstructions(PlannerOutputSchema),
  });
  const messages: ChatMessage[] = compiled.messages;
  // Budget guard: the assembled planner prompt must fit the planner
  // profile's conservative UTF-8-byte input budget before tokens are spent.
  assertCompiledPromptWithinProfileV1("planner", "planner", messages);

  const response = await provider.chat({
    messages,
    ...(provider.supportsReasoning ? {} : { temperature: 0 }),
    ...(reasoningConfig ? { reasoning: reasoningConfig } : {}),
    ...(compiled.cache.cacheEligible ? { cacheEligible: compiled.cache.cacheEligible } : {}),
    // No cacheEligible: planner calls are one-shot, so the anthropic protocol
    // omits cache markers entirely (no cache-write premium for a cache the
    // call never re-reads).
    schema: provider.supportsStructuredOutput ? PlannerOutputSchema : undefined,
    ...(signal ? { signal } : {}),
  });

  requireDirectVisibleOutput(response);

 // Return cachedInputTokens + pre-computed costUsd (see navigatorCallDirect).
  return extractUsage(response);
}

/**
 * One compaction summarization call — direct call to the LLM provider.
 *
 * This is the production path the extension wires for `deps.summarizeCall`, so
 * compaction's deterministic bounded summarization request (built and bounded
 * in `runCompaction`) is what actually crosses the network. The combined
 * system + user prompt is re-asserted against the compaction budget here as
 * defense-in-depth, mirroring the navigator/planner guards.
 */
export async function summarizeCallDirect(
  req: { systemPrompt: string; userPrompt: string; signal?: AbortSignal },
): Promise<{ content: string; usage?: TokenUsage }> {
  const provider = await raceWithAbort(getProvider(), req.signal);
  assertCompiledPromptWithinProfileV1("compaction", "compaction", [
    { content: req.systemPrompt },
    { content: req.userPrompt },
  ]);
  const response = await provider.chat({
    messages: [
      { role: "system", content: req.systemPrompt },
      { role: "user", content: req.userPrompt },
    ],
    temperature: 0,
    // Compaction is a one-shot summarization; the compacted result is never
    // cached by this call, so no cache marker is sent.
    ...(req.signal ? { signal: req.signal } : {}),
  });
  requireDirectVisibleOutput(response);
  const usage = extractUsage(response);
  const tokenUsage: TokenUsage | undefined =
    usage.tokensIn !== undefined && usage.tokensOut !== undefined && usage.model
      ? {
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          model: usage.model,
          reasoningTokens: usage.reasoningTokens,
          cachedInputTokens: usage.cachedInputTokens,
          cachedWriteInputTokens: usage.cachedWriteInputTokens,
          costUsd: usage.costUsd,
        }
      : undefined;
  return {
    content: usage.raw,
    usage: tokenUsage,
  };
}
