/**
 * Shared validation constants — used by the extension and the core agent
 * library. The Zod schemas that were here were only used by the (now-removed)
 * Next.js dev playground API routes; the extension uses its own validation
 * path via `provider-config.ts` + the core agent's `output-parser.ts`.
 */

export const MAX_ACTIONS = 10;
/** Canonical default for `maxActions` — single source of truth for the prompt builder and the bridge. */
export const DEFAULT_MAX_ACTIONS = MAX_ACTIONS;
export const MAX_ELEMENTS_CHARS = 200_000;
