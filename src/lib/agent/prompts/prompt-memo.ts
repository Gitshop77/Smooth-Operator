/**
 * Prompt memo — memoizes the compiled navigator/planner system prompts and
 * their cache descriptors for the duration of an agent run.
 *
 * The system prompt is a pure function of (maxActions, customPrompt,
 * visionMode, mode, systemSuffix) — byte-deterministic across steps,
 * retries, and replans. Memoizing removes the per-step ~28KB string build and
 * the per-step encode+SHA-256 in `createPromptCacheDescriptorV1`; retries
 * (up to 3×/step) become nearly free.
 *
 * SW-lifecycle note: the memo is module state in the MV3 service worker — it
 * dies with the SW on 30s idle termination and rebuilds per activation.
 * `clearPromptMemo()` is therefore idempotent and cheap (clearing empty maps
 * is a no-op), so re-keying on SW wake is never a cost.
 */

import { buildNavigatorPrompt } from "./navigator-prompt";
import type { VisionMode } from "./navigator-prompt-helpers";
import { buildPlannerPrompt } from "./planner-prompt";
import {
  createPromptCacheDescriptorV1,
  type PromptCacheDescriptorOptionsV1,
} from "./prompt-cache-descriptor";
import type { PromptCacheDescriptorV1, PromptSectionV1 } from "./prompt-contract";

const navigatorSystemMemo = new Map<string, string>();
const plannerSystemMemo = new Map<string, string>();
const cacheDescriptorMemo = new Map<string, Promise<PromptCacheDescriptorV1>>();

/** Normalize optional args to their effective defaults so equivalent call
 * shapes share one entry (mirrors buildNavigatorPrompt's parameter defaults).
 * `enabledActions` is order-insensitive — sorted for a stable key. */
function navigatorSystemKey(
  maxActions: number,
  customPrompt: string | undefined,
  visionMode: VisionMode | undefined,
  mode: string | undefined,
  systemSuffix: string | undefined,
  enabledActions: ReadonlySet<string> | undefined,
): string {
  return JSON.stringify([
    maxActions,
    customPrompt ?? null,
    visionMode ?? "disabled",
    mode ?? "standard",
    systemSuffix ?? null,
    enabledActions ? [...enabledActions].sort() : null,
  ]);
}

/**
 * Memoized navigator system prompt: `buildNavigatorPrompt(...)` + the exact
 * provider-facing suffix, keyed by the exact argument tuple. Returns the same
 * string for the same arguments — never rebuilds within a memo lifetime.
 */
export function memoizedNavigatorSystem(
  maxActions: number,
  customPrompt?: string,
  visionMode?: VisionMode,
  mode?: string,
  systemSuffix?: string,
  enabledActions?: ReadonlySet<string>,
): string {
  const key = navigatorSystemKey(maxActions, customPrompt, visionMode, mode, systemSuffix, enabledActions);
  let system = navigatorSystemMemo.get(key);
  if (system === undefined) {
    system = buildNavigatorPrompt(maxActions, customPrompt, visionMode, mode, enabledActions) + (systemSuffix ?? "");
    navigatorSystemMemo.set(key, system);
  }
  return system;
}

/**
 * Memoized planner system prompt: `buildPlannerPrompt(...)` + the exact
 * provider-facing suffix, keyed by the argument tuple.
 */
export function memoizedPlannerSystem(customPrompt?: string, systemSuffix?: string): string {
  const key = JSON.stringify([customPrompt ?? null, systemSuffix ?? null]);
  let system = plannerSystemMemo.get(key);
  if (system === undefined) {
    system = buildPlannerPrompt(customPrompt) + (systemSuffix ?? "");
    plannerSystemMemo.set(key, system);
  }
  return system;
}

/**
 * Memoized prompt-cache descriptor. The descriptor is a deterministic function
 * of the STABLE sections (id + exact text), `cacheEligible`, and the sorted
 * invalidation keys — the volatile per-step user payload never shapes it — so
 * it is keyed by exactly those inputs and the SHA-256 is computed once per
 * stable system text per memo lifetime. Returns the in-flight promise to
 * dedupe concurrent compiles.
 */
export function memoizedCacheDescriptorV1(
  sections: PromptSectionV1[],
  options: PromptCacheDescriptorOptionsV1,
): Promise<PromptCacheDescriptorV1> {
  const firstVolatile = sections.findIndex((section) => section.cache !== "stable");
  const stableSections = firstVolatile === -1 ? sections : sections.slice(0, firstVolatile);
  const cacheEligible = options.cacheEligible && stableSections.length > 0;
  const invalidationKeys = [...new Set(options.invalidationKeys)].sort();
  const key = JSON.stringify([
    stableSections.map((section) => `${section.id}\0${section.text}`),
    cacheEligible,
    invalidationKeys,
  ]);
  let cached = cacheDescriptorMemo.get(key);
  if (cached === undefined) {
    cached = createPromptCacheDescriptorV1(sections, options);
    cacheDescriptorMemo.set(key, cached);
  }
  return cached;
}

/** Drop every memoized entry. Idempotent and cheap — call on SW wake and on
 * any storage change touching a prompt-affecting setting. */
export function clearPromptMemo(): void {
  navigatorSystemMemo.clear();
  plannerSystemMemo.clear();
  cacheDescriptorMemo.clear();
}