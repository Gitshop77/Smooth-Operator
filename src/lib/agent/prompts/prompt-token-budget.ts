import {
  PROMPT_CONTRACT_VERSION,
  type PromptBudgetPortV1,
  type PromptKindV1,
} from "./prompt-contract";

/**
 * V1 is deliberately conservative: one UTF-8 byte is counted as one possible
 * input token. Provider tokenizers can combine bytes, so this is a deterministic
 * upper bound that never depends on a provider package or mutable catalog data.
 */
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
    super(`Prompt budget exceeded for ${label}: ${estimatedTokens} > ${maxTokens} UTF-8-byte tokens`);
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

/** Fixed, catalog-independent safety floors. Provider usage remains authoritative for billing. */
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
 * Derive a budget profile for a KNOWN model context window. The fixed V1
 * profiles assume a 128k context (navigator) / 64k (planner) / 32k
 * (judge+compaction); a 32k/64k-class model must never receive an
 * over-context prompt, so this recomputes `maxInputTokens` as
 * `contextTokens − outputReserve − reasoningReserve` (same reserves as the
 * base profile), clamped to an 8k floor. The estimator stays the
 * conservative UTF-8-byte upper bound (bytes≈tokens — safe for every
 * tokenizer), so a profile derived here is a deterministic over-estimate.
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
  return Object.freeze({
    version: base.version,
    kind,
    contextTokens: effective,
    outputReserveTokens: base.outputReserveTokens,
    reasoningReserveTokens: base.reasoningReserveTokens,
    maxInputTokens: Math.max(
      CONTEXT_CLAMP_FLOOR_TOKENS,
      effective - base.outputReserveTokens - base.reasoningReserveTokens,
    ),
  });
}

/** Assert a single text body stays within a model-context-aware budget. */
export function assertPromptWithinContextBudgetV1(
  kind: PromptKindV1,
  label: string,
  text: string,
  contextTokens: number,
): void {
  const profile = promptBudgetProfileForContextV1(kind, contextTokens);
  UTF8_PROMPT_BUDGET_V1.assertWithinBudget(label, text, profile.maxInputTokens);
}

/** Assert a compiled prompt's combined message bodies stay within a
 * model-context-aware budget (same `\n` framing reserve as
 * {@link assertCompiledPromptWithinProfileV1}). */
export function assertCompiledPromptWithinContextBudgetV1(
  kind: PromptKindV1,
  label: string,
  messages: readonly { content: string }[],
  contextTokens: number,
): void {
  const combined = messages.map((message) => message.content).join("\n");
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
  messages: readonly { content: string }[],
): void {
  const combined = messages.map((message) => message.content).join("\n");
  assertPromptWithinProfileV1(kind, label, combined);
}
