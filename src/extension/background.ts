/**
 * background.ts — esbuild entry shim for the MV3 service worker.
 *
 * The actual service-worker logic lives in `./background/index.ts` and its
 * sibling modules (`state-store`, `tab-manager`, `agent-bridge`,
 * `message-routing`, `task-queue`). This file is a one-line side-effect
 * import that triggers `background/index.ts`'s top-level listener
 * registrations + SW-startup check.
 *
 * esbuild bundles this file to `chrome-extension/background.js`. The entry
 * must stay at `src/extension/background.ts` because `esbuild.config.ts`
 * resolves it via `path.join(SRC, "background.ts")`.
 */

import "./background/index";
