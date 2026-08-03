/**
 * Shared validation constants — used by the extension layer (llm-direct,
 * settings-sync, agent-bridge) and the core agent library.
 */

export const MAX_ACTIONS = 10;
/** Canonical default for `maxActions` — single source of truth for the prompt builder and the bridge. */
export const DEFAULT_MAX_ACTIONS = MAX_ACTIONS;
export const MAX_ELEMENTS_CHARS = 200_000;
