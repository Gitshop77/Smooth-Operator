/**
 * Shared validation constants — used by the extension layer (llm-direct,
 * settings-sync, agent-bridge) and the core agent library.
 */

import { BASE_OBS_ELEMENTS_CHARS } from "./agent/prompts/prompt-token-budget";

export const MAX_ACTIONS = 10;
/** Canonical default for `maxActions` — single source of truth for the prompt builder and the bridge. */
export const DEFAULT_MAX_ACTIONS = MAX_ACTIONS;
/** Defense-in-depth cap on elementsText chars for hypothetical direct callers
 * — derived from the observation-budget base (prompt-token-budget.ts). The
 * loop truncates elementsText to its per-step derived budget (≤ this) before
 * llm-direct sees it, so this is unreachable by construction; kept as a
 * fail-closed backstop in security-sensitive code. */
export const MAX_ELEMENTS_CHARS = BASE_OBS_ELEMENTS_CHARS;
