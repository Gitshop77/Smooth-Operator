/**
 * Loop helper — `waitForTakeoverResume`.
 *
 * Extracted from the original `loop/helpers.ts`.
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
 * Race an external resume trigger against a hard timeout + abort signal.
 *
 * Owns the `done` guard, the timeout timer, and the abort listener so neither
 * leaks. The caller supplies only its distinct resume trigger via `arm`, which
 * receives `finish` to call with the outcome. Both resume paths in
 * {@link waitForTakeoverResume} share this; only their `arm` differs.
 */
function raceResumeWithTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
  arm: (finish: (result: "resumed" | "timeout") => void) => void,
  cleanup?: () => void,
): Promise<"resumed" | "timeout"> {
  return new Promise<"resumed" | "timeout">((resolve) => {
    let done = false;
 // Must stay `let` (declared, uninitialized): `arm(finish)` below can invoke
 // `finish` synchronously (e.g. an already-aborted signal), and `finish` calls
 // `clearTimeout(timer)`. Keeping `timer` in scope but unassigned makes that a
 // safe `clearTimeout(undefined)` no-op; a `const` initialized after `arm`
 // would throw a TDZ ReferenceError on that synchronous path.
 // eslint-disable-next-line prefer-const
    let timer: ReturnType<typeof setTimeout>;
    let abortListener: (() => void) | null = null;
    const finish = (result: "resumed" | "timeout"): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (abortListener && signal) {
        try { signal.removeEventListener("abort", abortListener); } catch { /* ignore */ }
        abortListener = null;
      }
      cleanup?.();
      resolve(result);
    };
 // Arm the caller's distinct resume trigger first (push to the registry /
 // fire the override) so it happens before the timer + abort check — matching
 // the original per-branch ordering in which a synchronous abort can still
 // clean up the registry entry.
    arm(finish);
    timer = setTimeout(() => finish("timeout"), timeoutMs);
    if (signal) {
      if (signal.aborted) finish("timeout");
      else {
        abortListener = () => finish("timeout");
        signal.addEventListener("abort", abortListener);
      }
    }
  });
}

/**
 * Only trust a RESUME that originates from our own extension and that is NOT
 * carried on a content-script `tab` — i.e. a message from one of our own
 * extension pages (the sidepanel/options), never from a content script injected
 * into a web page or from another extension. Without this check any sender
 * could un-pause the agent loop.
 */
export function isTrustedResumeSender(sender?: chrome.runtime.MessageSender): boolean {
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
/** Safety bound: if more than this many pauses accumulate without resolution
 * (e.g. extension context invalidation mid-pause), clear stale entries to
 * prevent unbounded memory growth within a service-worker session. */
const MAX_ACTIVE_RESUME_FINISHERS = 10;
// Tracks the exact `chrome.runtime.onMessage` object we already attached our
// shared listener to, so a *different* (re-installed) `onMessage` — e.g. a test
// harness that swaps the global `chrome` between cases, or a genuine context
// re-validation — re-attaches correctly instead of silently no-op'ing because a
// stale boolean flag was still set. Falls back to at most one listener per
// distinct `onMessage` instance.
let attachedOnMessage: unknown = null;

function attachResumeListener(): void {
  const om = chrome.runtime?.onMessage;
  if (!om || attachedOnMessage === om) return;
  try {
    om.addListener(
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
 // Only mark attached once addListener has actually succeeded, so a
 // throwing call (e.g. extension context invalidated) leaves the flag
 // false and the next wait retries — rather than silently breaking RESUME
 // for the whole session.
    attachedOnMessage = om;
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
    return raceResumeWithTimeout(deps.signal, TAKEOVER_TIMEOUT_MS, (finish) => {
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
    });
  }

  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    let removeFromRegistry: (() => void) | undefined;
    return raceResumeWithTimeout(deps.signal, TAKEOVER_TIMEOUT_MS, (finish) => {
 // The shared onMessage listener holds a reference to `finish`; remove it
 // from the registry on every resolution path (RESUME, timeout, or abort)
 // so a resolved/expired pause can't be released again by a later RESUME
 // and the registry can't grow without bound across the session.
      const finishWithRegistry = (result: "resumed" | "timeout"): void => {
        removeFromRegistry?.();
        finish(result);
      };
      removeFromRegistry = () => {
        const idx = activeResumeFinishers.indexOf(finishWithRegistry);
        if (idx >= 0) activeResumeFinishers.splice(idx, 1);
      };
      if (activeResumeFinishers.length >= MAX_ACTIVE_RESUME_FINISHERS) {
        console.warn(
          `[takeover] activeResumeFinishers exceeded ${MAX_ACTIVE_RESUME_FINISHERS} — clearing stale entries`,
        );
        activeResumeFinishers.length = 0;
      }
      activeResumeFinishers.push(finishWithRegistry);
      attachResumeListener();
    }, () => removeFromRegistry?.());
  }

  deps.onEvent({
    type: "info",
    message: "Takeover resume not available in this context — continuing without pause.",
  });
  return "skipped";
}
