/**
 * sidepanel.ts — esbuild entry shim for the side panel UI logic.
 *
 * The actual side panel logic lives in `./sidepanel/index.ts` and its sibling
 * modules (log-renderer, controls, takeover, human-interact, lifecycle). This
 * file is a one-line side-effect import that triggers `sidepanel/index.ts`'s
 * top-level element-ref setup + hydration + the sibling modules' listener
 * registration.
 *
 * esbuild bundles this file to `chrome-extension/sidepanel.js`. The entry
 * must stay at `src/extension/sidepanel.ts` because `esbuild.config.ts`
 * resolves it via `path.join(SRC, "sidepanel.ts")`.
 */

import "./sidepanel/index";
