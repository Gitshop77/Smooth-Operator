/**
 * Loop helper — `waitForTakeoverResume`.
 *
 * Extracted from the original `loop/helpers.ts` (Phase 10a).
 *
 * Wait for the user to resume after a `takeover` action. Emits a `takeover`
 * event + an info banner, then awaits one of:
 *   - `deps.requestTakeoverResume` (caller-provided override), or
 *   - a `{ type: "RESUME" }` chrome.runtime message (extension context), or
 *   - immediate resolution (in-page demo / tests).
 */

import type { LoopDeps } from "../types";
import { TAKEOVER_TIMEOUT_MS } from "../constants";

export async function waitForTakeoverResume(
  deps: LoopDeps,
  reason: string,
  step: number
): Promise<"resumed" | "timeout" | "skipped"> {
  deps.onEvent({ type: "takeover", step, reason });
  deps.onEvent({
    type: "info",
    message: `Agent paused: ${reason}. Please perform the action manually, then click Resume.`,
  });

  if (deps.requestTakeoverResume) {
    // Race the caller-provided override against a timeout + abort signal so a
    // custom `requestTakeoverResume` that never resolves/rejects can't hang the
    // loop (the chrome.runtime.onMessage path below already has a hard timeout).
    return await new Promise<"resumed" | "timeout">((resolve) => {
      let done = false;
      let abortListener: (() => void) | null = null;
      // Mirror the message-path's `finish` design: clear the timer + abort
      // listener on resolution so neither leaks.
      const finish = (result: "resumed" | "timeout"): void => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        if (abortListener && deps.signal) {
          try { deps.signal.removeEventListener("abort", abortListener); } catch { /* ignore */ }
          abortListener = null;
        }
        resolve(result);
      };
      // Fire-and-forget the override; `finish` resolves the promise when it
      // settles (resumed on success, timeout on rejection/abort/expiry).
      (async () => {
        try {
          await deps.requestTakeoverResume!(reason, deps.signal);
          finish("resumed");
        } catch {
          finish("timeout");
        }
      })();
      const timer = setTimeout(() => finish("timeout"), TAKEOVER_TIMEOUT_MS);
      if (deps.signal) {
        if (deps.signal.aborted) finish("timeout");
        else {
          abortListener = () => finish("timeout");
          deps.signal.addEventListener("abort", abortListener);
        }
      }
    });
  }

  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    return await new Promise<"resumed" | "timeout">((resolve) => {
      let done = false;
      // Keep references to every listener we register so we can remove
      // them in `finish()`. Previously only the chrome.runtime.onMessage
      // listener was removed; the `signal.addEventListener("abort", …)`
      // callback was leaked — once `signal` aborted (or even when it didn't),
      // the closure kept `finish` + `timer` + the Promise alive on the
      // signal's listener list for the lifetime of the AbortSignal (often the
      // whole run). Removing it explicitly breaks that reference chain.
      let abortListener: (() => void) | null = null;
      const finish = (result: "resumed" | "timeout"): void => {
        if (done) return;
        done = true;
        try { chrome.runtime.onMessage.removeListener(listener); } catch { /* ignore */ }
        // Also remove the abort listener (if we registered one) so the
        // AbortSignal doesn't retain a dead closure.
        if (abortListener && deps.signal) {
          try { deps.signal.removeEventListener("abort", abortListener); } catch { /* ignore */ }
          abortListener = null;
        }
        clearTimeout(timer);
        resolve(result);
      };
      const listener = (msg: unknown): void => {
        if ((msg as { type?: string } | null)?.type === "RESUME") {
          finish("resumed");
        }
      };
      try {
        chrome.runtime.onMessage.addListener(listener);
      } catch {
        resolve("timeout");
        return;
      }
      const timer = setTimeout(() => finish("timeout"), TAKEOVER_TIMEOUT_MS);
      if (deps.signal) {
        if (deps.signal.aborted) finish("timeout");
        else {
          abortListener = () => finish("timeout");
          deps.signal.addEventListener("abort", abortListener);
        }
      }
    });
  }

  deps.onEvent({
    type: "info",
    message: "Takeover resume not available in this context — continuing without pause.",
  });
  return "skipped";
}
