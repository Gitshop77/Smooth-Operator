/**
 * Loop helper — `waitForTakeoverResume`.
 *
 * Extracted from the original `loop/helpers.ts` (Phase 10a).
 *
 * Wait for the user to resume after a `takeover` action. Emits a `takeover`
 * event + an info banner, then awaits one of:
 * - `deps.requestTakeoverResume` (caller-provided override), or
 * - a `{ type: "RESUME" }` chrome.runtime message (extension context), or
 * - immediate resolution (in-page demo / tests).
 */

import type { LoopDeps } from "../types";
import { TAKEOVER_TIMEOUT_MS } from "../constants";

/**
 * Only trust a RESUME that originates from our own extension and that is NOT
 * carried on a content-script `tab` — i.e. a message from one of our own
 * extension pages (the sidepanel/options), never from a content script injected
 * into a web page or from another extension. Without this check any sender
 * could un-pause the agent loop.
 */
function isTrustedResumeSender(sender?: chrome.runtime.MessageSender): boolean {
  return (
    !!sender &&
    sender.id === chrome.runtime.id &&
    !sender.tab
  );
}

/**
 * Registry of currently-paused waits. A single RESUME broadcast should release
 * only the most-recent active pause — previously each wait registered its own
 * listener and a single broadcast resolved *every* concurrent wait. We keep a
 * module-level list and a single shared onMessage listener so one RESUME
 * resolves exactly one pause (the latest). This also bounds the listener
 * footprint to one per context instead of one per wait.
 *
 * (A fully-correlated per-pause token would additionally require the RESUME
 * sender — the sidepanel/options page — to embed and echo a pause id, which is
 * a cross-file protocol change outside this module's ownership. The
 * latest-wins strategy here is a strict improvement and prevents the
 * all-resolve bug.)
 */
const activeResumeFinishers: Array<(r: "resumed" | "timeout") => void> = [];
let resumeListenerAttached = false;

function attachResumeListener(): void {
  if (resumeListenerAttached) return;
  resumeListenerAttached = true;
  try {
    chrome.runtime.onMessage.addListener(
      (msg: unknown, sender?: chrome.runtime.MessageSender): void => {
        if (
          (msg as { type?: string } | null)?.type === "RESUME" &&
          isTrustedResumeSender(sender)
        ) {
 // Release only the most-recent active pause.
          const fin = activeResumeFinishers.pop();
          fin?.("resumed");
        }
      }
    );
  } catch {
    /* listener attachment failed — waits simply fall back to timeout */
  }
}

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
      let abortListener: (() => void) | null = null;
 // The shared listener holds a reference to `finish`; remove it from the
 // registry on every resolution path so a resolved/expired pause can't be
 // released again by a later RESUME.
      const finish = (result: "resumed" | "timeout"): void => {
        if (done) return;
        done = true;
        const idx = activeResumeFinishers.indexOf(finish);
        if (idx >= 0) activeResumeFinishers.splice(idx, 1);
        if (abortListener && deps.signal) {
          try { deps.signal.removeEventListener("abort", abortListener); } catch { /* ignore */ }
          abortListener = null;
        }
        clearTimeout(timer);
        resolve(result);
      };
      activeResumeFinishers.push(finish);
      attachResumeListener();
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
