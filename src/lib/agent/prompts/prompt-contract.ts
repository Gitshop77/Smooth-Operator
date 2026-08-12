import type { ChatMessage } from "../llm/provider";

export const PROMPT_CONTRACT_VERSION = 1 as const;
export const PROMPT_CACHE_KEY_VERSION = "sha256-stable-section-v1" as const;

export type PromptKindV1 = "navigator" | "planner" | "judge" | "compaction";
export type PromptTrustV1 =
  | "system"
  | "trusted-user"
  | "trusted-local"
  | "untrusted-page"
  | "untrusted-model";
export type PromptProvenanceV1 =
  | "application"
  | "user"
  | "settings"
  | "page"
  | "history"
  | "runtime";
export type PromptVolatilityV1 = "stable" | "configuration" | "run" | "request" | "page";

export interface PromptSectionV1 {
  version: typeof PROMPT_CONTRACT_VERSION;
  id: string;
  role: ChatMessage["role"];
  text: string;
  trust: PromptTrustV1;
  provenance: PromptProvenanceV1;
  volatility: PromptVolatilityV1;
  required: boolean;
  cache: "stable" | "volatile" | "ineligible";
}

/**
 * Content-free cache metadata. It may cross diagnostics/evidence boundaries:
 * only section ids, policy/version labels, and a one-way digest are retained.
 */
export interface PromptCacheDescriptorV1 {
  version: typeof PROMPT_CONTRACT_VERSION;
  keyVersion: typeof PROMPT_CACHE_KEY_VERSION;
  cacheEligible: boolean;
  stableKey: string | null;
  stableSectionIds: string[];
  volatileSectionIds: string[];
  /** Index of the first non-stable section; -1 means no volatile section. */
  volatileBoundary: number;
  /** Named inputs whose change requires a fresh descriptor/key. */
  invalidationKeys: string[];
}

export interface CompiledPromptV1 {
  version: typeof PROMPT_CONTRACT_VERSION;
  kind: PromptKindV1;
  sections: PromptSectionV1[];
  messages: ChatMessage[];
  cache: PromptCacheDescriptorV1;
}

/** Shared seam for the deterministic Phase 8 token-budget implementation. */
export interface PromptBudgetPortV1 {
  readonly version: typeof PROMPT_CONTRACT_VERSION;
  estimateTokens(text: string): number;
  assertWithinBudget(label: string, text: string, maxTokens: number): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

/** Strict decoder for persisted/transported content-free cache descriptors. */
export function decodePromptCacheDescriptorV1(value: unknown): PromptCacheDescriptorV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "version",
    "keyVersion",
    "cacheEligible",
    "stableKey",
    "stableSectionIds",
    "volatileSectionIds",
    "volatileBoundary",
    "invalidationKeys",
  ])) return null;
  if (value.version !== PROMPT_CONTRACT_VERSION || value.keyVersion !== PROMPT_CACHE_KEY_VERSION) return null;
  if (typeof value.cacheEligible !== "boolean") return null;
  if (value.stableKey !== null &&
      (typeof value.stableKey !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.stableKey))) return null;
  if (!isStringArray(value.stableSectionIds) || !isStringArray(value.volatileSectionIds) ||
      !isStringArray(value.invalidationKeys)) return null;
  if (!Number.isSafeInteger(value.volatileBoundary) || (value.volatileBoundary as number) < -1) return null;
  if (value.cacheEligible && (value.stableKey === null || value.stableSectionIds.length === 0)) return null;
  if (!value.cacheEligible && value.stableKey !== null) return null;
  return {
    version: PROMPT_CONTRACT_VERSION,
    keyVersion: PROMPT_CACHE_KEY_VERSION,
    cacheEligible: value.cacheEligible,
    stableKey: value.stableKey,
    stableSectionIds: [...value.stableSectionIds],
    volatileSectionIds: [...value.volatileSectionIds],
    volatileBoundary: value.volatileBoundary as number,
    invalidationKeys: [...value.invalidationKeys],
  };
}
