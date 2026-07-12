/**
 * Shared handler context. `executeAction` captures `beforeUrl` +
 * `beforeFingerprint` once at the top of its try block, then passes them
 * to every handler via this context. The handful of handlers that need
 * page-change detection (click, go_back, press_and_hold, evaluate) read the
 * `beforeUrl`/`beforeFingerprint` fields; the rest ignore them. (`go_back`
 * consults only `beforeUrl`; `evaluate` also reads `beforeFingerprint` to
 * decide `pageChanged`.)
 */

import type { BrowserState } from "../../types";

export interface ActionContext {
  /** The current browser state (used to resolve `[index]` → element). */
  state: BrowserState;
  /** `location.href` captured BEFORE the handler ran. */
  beforeUrl: string;
  /** `domFingerprint()` captured BEFORE the handler ran. */
  beforeFingerprint: string;
}
