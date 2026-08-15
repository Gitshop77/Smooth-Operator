import {
  PROMPT_CONTRACT_VERSION,
  type PromptBudgetPortV1,
  type PromptKindV1,
} from "./prompt-contract";
import type { ImagePartV1 } from "../llm/image-part";

/** V1 keeps a byte-exact guard for the legacy unknown-context path. Runs with
 * a known effective context use the portable token fallback below and then
 * replace it with provider-reported usage after every successful request. */
export const PROMPT_BUDGET_VERSION = PROMPT_CONTRACT_VERSION;

const encoder = new TextEncoder();

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

export class PromptBudgetExceededError extends Error {
  readonly name = "PromptBudgetExceededError";
  readonly code = "PROMPT_BUDGET_EXCEEDED" as const;
  readonly version = PROMPT_BUDGET_VERSION;
  readonly budgetExceeded = true;

  constructor(
    readonly label: string,
    readonly estimatedTokens: number,
    readonly maxTokens: number,
  ) {
    super(`Prompt budget exceeded for ${label}: ${estimatedTokens} > ${maxTokens} estimated tokens`);
  }
}

export interface PromptBudgetProfileV1 {
  readonly version: typeof PROMPT_BUDGET_VERSION;
  readonly kind: PromptKindV1;
  readonly contextTokens: number;
  readonly outputReserveTokens: number;
  readonly reasoningReserveTokens: number;
  readonly maxInputTokens: number;
}

function profile(
  kind: PromptKindV1,
  contextTokens: number,
  outputReserveTokens: number,
  reasoningReserveTokens: number,
): PromptBudgetProfileV1 {
  return Object.freeze({
    version: PROMPT_BUDGET_VERSION,
    kind,
    contextTokens,
    outputReserveTokens,
    reasoningReserveTokens,
    maxInputTokens: contextTokens - outputReserveTokens - reasoningReserveTokens,
  });
}

/** Fixed, catalog-independent guards used only when the model context is
 * genuinely unknown. Known-context runs derive an 85/15 profile below. */
export const PROMPT_BUDGET_PROFILES_V1: Readonly<Record<PromptKindV1, PromptBudgetProfileV1>> =
  Object.freeze({
    navigator: profile("navigator", 128_000, 8_192, 16_384),
    planner: profile("planner", 64_000, 8_192, 8_192),
    judge: profile("judge", 32_000, 4_096, 4_096),
    compaction: profile("compaction", 32_000, 2_048, 4_096),
  });

function validateBudget(maxTokens: number): void {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 0) {
    throw new TypeError("Prompt budget must be a non-negative safe integer");
  }
}

export const UTF8_PROMPT_BUDGET_V1: PromptBudgetPortV1 = Object.freeze({
  version: PROMPT_BUDGET_VERSION,
  estimateTokens(text: string): number {
    return utf8ByteLength(text);
  },
  assertWithinBudget(label: string, text: string, maxTokens: number): void {
    validateBudget(maxTokens);
    const estimate = utf8ByteLength(text);
    if (estimate > maxTokens) {
      throw new PromptBudgetExceededError(label, estimate, maxTokens);
    }
  },
});

export function assertPromptWithinProfileV1(kind: PromptKindV1, label: string, text: string): void {
  UTF8_PROMPT_BUDGET_V1.assertWithinBudget(label, text, PROMPT_BUDGET_PROFILES_V1[kind].maxInputTokens);
}

// ─── Model-context-aware budgets (32k/64k-class models) ──────────────────────

/** Absolute floor (tokens) for a derived context-clamped profile. Degenerate
 * or tiny inputs still yield a usable, conservative budget. */
export const CONTEXT_CLAMP_FLOOR_TOKENS = 8_000;

/**
 * Derive a budget profile for a KNOWN model context window. Input may occupy
 * at most 85%; the remaining 15% is the combined visible-output + hidden
 * reasoning allowance because provider protocols account both under the same
 * completion/output ceiling.
 */
export function promptBudgetProfileForContextV1(
  kind: PromptKindV1,
  contextTokens: number,
): PromptBudgetProfileV1 {
  if (!Number.isSafeInteger(contextTokens) || contextTokens <= 0) {
    throw new TypeError("contextTokens must be a positive safe integer");
  }
  const base = PROMPT_BUDGET_PROFILES_V1[kind];
  const effective = Math.max(CONTEXT_CLAMP_FLOOR_TOKENS, contextTokens);
  const maxInputTokens = Math.floor(effective * 0.85);
  return Object.freeze({
    version: base.version,
    kind,
    contextTokens: effective,
    // The remaining 15% is one COMBINED generation allowance. Provider
    // protocols count hidden reasoning inside completion/output tokens, so a
    // second hardcoded reasoning reserve would double-count the same capacity.
    outputReserveTokens: effective - maxInputTokens,
    reasoningReserveTokens: 0,
    maxInputTokens,
  });
}

/** Portable fallback for providers that expose no tokenizer/count endpoint.
 * Natural-language, code, and DOM prompts commonly encode at 2-4 UTF-8 bytes
 * per token; 2 bytes/token is deliberately conservative without the extreme
 * 1-byte/token under-utilization that rejected a real 7.8K-token llama.cpp
 * prompt as if it were 40K tokens. Provider-reported input usage remains the
 * authority for the 85% compaction trigger after each successful call. */
export function estimatePromptTokensFallbackV1(text: string): number {
  return Math.ceil(utf8ByteLength(text) / 2);
}

/** Assert a single text body stays within a model-context-aware budget. */
export function assertPromptWithinContextBudgetV1(
  kind: PromptKindV1,
  label: string,
  text: string,
  contextTokens: number,
): void {
  const profile = promptBudgetProfileForContextV1(kind, contextTokens);
  const estimate = estimatePromptTokensFallbackV1(text);
  if (estimate > profile.maxInputTokens) {
    throw new PromptBudgetExceededError(label, estimate, profile.maxInputTokens);
  }
}

/** Message body type accepted by the compiled-prompt budget asserts: plain
 * text or a parts array (text + structured image parts). */
export type PromptMessageBodyV1 = string | Array<string | ImagePartV1>;

/**
 * Flatten a (possibly structured) message body to its TEXT representation for
 * the byte-budget join. Image parts are represented by their full base64
 * payload: the plain (no-accounting) path is deliberately conservative — it
 * has no flat per-image token allowance to substitute, so a screenshot-heavy
 * prompt must fail closed rather than pass on a false text-only estimate.
 */
function messageBodyText(content: PromptMessageBodyV1): string {
  if (typeof content === "string") return content;
  return content.map((part) => (typeof part === "string" ? part : part.dataUrl)).join("");
}

/** Assert a compiled prompt's combined message bodies stay within a
 * model-context-aware budget (same `\n` framing reserve as
 * {@link assertCompiledPromptWithinProfileV1}). */
export function assertCompiledPromptWithinContextBudgetV1(
  kind: PromptKindV1,
  label: string,
  messages: readonly { content: PromptMessageBodyV1 }[],
  contextTokens: number,
): void {
  const combined = messages.map((message) => messageBodyText(message.content)).join("\n");
  assertPromptWithinContextBudgetV1(kind, label, combined, contextTokens);
}

/**
 * Assert a compiled prompt's combined message bodies stay within the profile
 * for `kind`. The join with `\n` is deliberate: it adds a few bytes that real
 * transports may bill as framing, so the guard stays conservative (it never
 * under-estimates the message bodies that cross the network; actual wire bytes
 * may still exceed the estimate due to role labels/encoding, which only makes
 * the upper bound more conservative relative to true token counts).
 */
export function assertCompiledPromptWithinProfileV1(
  kind: PromptKindV1,
  label: string,
  messages: readonly { content: PromptMessageBodyV1 }[],
): void {
  const combined = messages.map((message) => messageBodyText(message.content)).join("\n");
  assertPromptWithinProfileV1(kind, label, combined);
}

// ─── Context-adaptive per-step observation caps ─────────────────────────────
//
// The navigator's per-step observation payloads (interactive-element DOM text,
// accessibility tree, screenshot) are bounded by HARD caps so a misconfigured
// run can never ship an unbounded payload. Those caps were calibrated for a
// 128k-context model. A 64k-class model with the SAME caps receives an
// over-context prompt and the fail-closed budget assert (in llm-direct) kills
// the step — so "works at 128k, breaks at 64k" with no graceful path.
//
// These derived caps are two-regime:
// - ≥128k context (or unknown): the exact current defaults — zero behavior
//   change for every model the current caps were calibrated for.
// - <128k context: a FITTING allocation — the observation channels are sized so
//   the text observation fits the model's derived input budget alongside the
//   fixed prompt overhead and a modest task/history payload. A smaller-context
//   model degrades the OBSERVATION instead of failing the STEP.
//
// The fail-closed assert remains the shared-resource backstop: a prompt that
// also carries a very large task/history payload (or fills several channels
// simultaneously) still fails closed rather than shipping over-context — that
// residual case is the compaction layer's job.

/** Per-channel observation caps for one navigator step. */
export interface NavigatorObservationCapsV1 {
  /** Cap on interactive-element DOM text chars. */
  elementsTextChars: number;
  /** Cap on accessibility-tree chars. 0 → the loop drops the AX channel. */
  axTreeChars: number;
  /** Cap on screenshot data-URL chars. 0 → the loop drops the screenshot
   * entirely (the channel is not affordable at this context). */
  screenshotChars: number;
}

/** Base per-channel caps at the 128k calibration point — the exact per-step
 * caps for unknown/≥128k-context runs. `ELEMENTS_TEXT_CHAR_CAP`
 * (messages-utils.ts) and `MAX_ELEMENTS_CHARS` (validations.ts) are DERIVED
 * from `BASE_OBS_ELEMENTS_CHARS`, so the message-layer and llm-direct caps can
 * never drift from the budget module. A derived cap NEVER exceeds its base, so
 * a 128k+ model keeps today's exact behavior. */
export const BASE_OBS_ELEMENTS_CHARS = 24_000;
const BASE_OBS_AXTREE_CHARS = 12_000;
const BASE_OBS_SCREENSHOT_CHARS = 100_000;

/**
 * Fixed non-observation navigator overhead (system prompt + base user-message
 * framing) in UTF-8 bytes. Measured ≈20.2k (19,576 system + ~600 base user
 * after the compact/full prose convergence); the margin absorbs prompt-version
 * drift.
 */
const NAVIGATOR_FIXED_OVERHEAD_BYTES = 32_000;

/**
 * Sub-128k models receive the COMPACT system prompt (~19.5KB measured — the
 * full and compact variants converged to within a few dozen bytes), so their
 * fixed overhead is correspondingly lower — the entire point of the compact
 * variant is to convert prompt bytes into observation headroom for
 * low-context models. 19,561 measured system + ~600 base user + a margin for
 * history growth past the user-content reserve (measured: a 20-step run's
 * history/task/plan/wrapping reaches ~5,000 bytes vs the 4,000 reserve — the
 * extra ~900 keeps the worst-case turn under the 39,424 budget).
 */
/** Absolute floor per channel so a degenerate tiny context can't derive
 * unusable 1-char caps. */
const MIN_OBS_ELEMENTS_CHARS = 2_000;

/** Smallest screenshot (data-URL chars) that is worth sending at all. Below
 * this the channel is dropped: sending a 3k-char image is pure cost with no
 * grounding value, and keeping it would just trip the budget assert. */
const MIN_USEFUL_SCREENSHOT_CHARS = 24_000;

/** Share of the economical text-observation budget given to elementsText. The
 * viewport AX tree gets the remainder: enough semantic evidence to avoid blind
 * scroll loops without duplicating the entire document. */
const ELEMENTS_TEXT_FIT_SHARE = 0.75;

/** Keep page evidence economical even when a model exposes a very large input
 * window. This is a per-step quality budget, not permission to fill 85% of the
 * context on every call. */
const MAX_SUB_128K_TEXT_OBSERVATION_CHARS = 24_000;
const MIN_SUB_128K_TEXT_OBSERVATION_CHARS = 8_000;

/**
 * Derive the per-step navigator observation caps for a KNOWN model context
 * window. `undefined` (unknown model / fixed-profile path) returns the exact
 * current defaults — zero behavior change for unknown-context runs.
 *
 * Regime ≥128k (or unknown): the base caps unchanged; the screenshot cap
 * becomes its FIT budget — what remains after the fixed overhead and a minimum
 * usable text observation. At 128k that is 72,800 chars (≈50KB image, ~640px) —
 * a bounded per-step quality budget. A 3M-char screenshot safety cap stays in
 * the loop as the OUTER drop guard (corrupt/hostile captures are never
 * re-encoded); over-budget frames are resized down to this fitted budget
 * instead of being shipped whole.
 *
 * Regime <128k: a bounded fraction of the derived input capacity is used for
 * text observation; elementsText gets 75% and the viewport AX tree
 * gets the remainder (dropped when it would be useless), and the screenshot
 * channel is dropped — a screenshot is not affordable at these budgets.
 * The fixed overhead uses the COMPACT system prompt (sub-128k models receive
 * it), which is what converts prompt bytes into observation headroom.
 */
export function deriveNavigatorObservationCapsV1(
  contextTokens: number | undefined,
): NavigatorObservationCapsV1 {
  if (contextTokens === undefined) {
    return {
      elementsTextChars: BASE_OBS_ELEMENTS_CHARS,
      axTreeChars: BASE_OBS_AXTREE_CHARS,
      screenshotChars: BASE_OBS_SCREENSHOT_CHARS,
    };
  }
  const profile = promptBudgetProfileForContextV1("navigator", contextTokens);
  const baseProfile = PROMPT_BUDGET_PROFILES_V1.navigator;

  // ≥128k-class model: use bounded quality caps rather than interpreting a
  // larger context window as permission to ship the whole page every step.
  if (profile.maxInputTokens >= baseProfile.maxInputTokens) {
    const screenshotFit = profile.maxInputTokens - NAVIGATOR_FIXED_OVERHEAD_BYTES
      - MIN_OBS_ELEMENTS_CHARS - MIN_OBS_ELEMENTS_CHARS;
    return {
      elementsTextChars: BASE_OBS_ELEMENTS_CHARS,
      axTreeChars: BASE_OBS_AXTREE_CHARS,
      screenshotChars: screenshotFit >= MIN_USEFUL_SCREENSHOT_CHARS
        ? Math.min(BASE_OBS_SCREENSHOT_CHARS, screenshotFit)
        : 0,
    };
  }

  // Sub-128k fitting regime. The fixed overhead uses the COMPACT system prompt
  // (these models get it — see llm-direct), converting prompt bytes into
  // observation headroom.
  // The old calculation subtracted the legacy 128k profile's output AND
  // reasoning reserves from a 64k context. That double-reserved generation
  // space even though promptBudgetProfileForContextV1 intentionally uses one
  // combined 15% reserve, leaving only 1,669 AX chars at 64k. Allocate a
  // bounded fraction of the real derived input capacity instead. Characters
  // are deliberately below the fallback estimator's 2 bytes/token allowance,
  // leaving ample room for the compact prompt, task and recent history.
  const available = Math.min(
    MAX_SUB_128K_TEXT_OBSERVATION_CHARS,
    Math.max(
      MIN_SUB_128K_TEXT_OBSERVATION_CHARS,
      Math.floor(profile.maxInputTokens * 0.65),
    ),
  );
  const elementsTextChars = Math.max(MIN_OBS_ELEMENTS_CHARS, Math.floor(available * ELEMENTS_TEXT_FIT_SHARE));
  const axTreeChars = Math.max(0, available - elementsTextChars);
  return { elementsTextChars, axTreeChars, screenshotChars: 0 };
}

/** A bounded image budget used only after the navigator explicitly requests
 * visual evidence. Automatic sub-128k screenshots remain disabled, but a 64k
 * multimodal model can deliberately trade some text observation for one useful
 * frame instead of being permanently blind. */
export function deriveOnDemandScreenshotCapV1(contextTokens: number | undefined): number {
  if (contextTokens === undefined) return BASE_OBS_SCREENSHOT_CHARS;
  if (contextTokens < 24_000) return 0;
  if (contextTokens >= 128_000) return deriveNavigatorObservationCapsV1(contextTokens).screenshotChars;
  return Math.min(56_000, Math.max(20_000, contextTokens - 8_000));
}
