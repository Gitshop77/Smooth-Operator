/**
 * options.ts — esbuild entry shim for the Options page logic.
 *
 * The actual Options page logic lives in `./options/index.ts` and its sibling
 * modules (settings-sync, provider-config-ui, scheduled-tasks, custom-tools,
 * skills, history, prompts, notifications). This file is a one-line
 * side-effect import that triggers `options/index.ts`'s top-level tab-switch
 * wiring + the sibling modules' form-hydration / event-listener registration.
 *
 * esbuild bundles this file to `chrome-extension/options.js`. The entry must
 * stay at `src/extension/options.ts` because `esbuild.config.ts` resolves it
 * via `path.join(SRC, "options.ts")`.
 */

import "./options/index";
