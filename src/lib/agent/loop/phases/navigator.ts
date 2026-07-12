/**
 * Phase: navigator — extracted from orchestrator.ts (Phase 1).
 *
 * The navigator LLM call with parse retry, the HTML-summarizer pre-pass,
 * and the post-observe challenge/pause checks. This is the "reason + act"
 * half of the loop; the actual action execution is in `helpers/action-queue.ts`.
 *
 * The helper `prepareNavigatorRequest` builds the AgentStepRequest from the
 * current state + browser state, applying the HTML-summarizer pre-pass when
 * enabled.
 */

import type { AgentStepRequest } from "../../types";
import type { LoopState } from "../types";
import type { BrowserState } from "../../types";
import {
  summarizeDom,
  renderElementsText,
  DEFAULT_MIN_HTML_LENGTH,
} from "../../html-summarizer";
import { buildPostObserveNudges } from "../context/injection-points";

/**
 * Hard upper bound on the DOM text shipped to the navigator model per step,
 * independent of the HTML summarizer. This guarantees a misconfigured run
 * (summarizer disabled or falling back) can NEVER send an unbounded DOM to the
 * provider — the single largest per-action cost lever in a paid LLM product.
 * When the raw/summarized DOM exceeds this, it is truncated and an info event
 * is emitted so the truncation is observable.
 */
const MAX_NAV_ELEMENTS_TEXT_CHARS = 60_000;

/**
 * Hard byte budget for the vision `screenshot` shipped to the navigator per
 * step. A full-DPR viewport can be a multi-megabyte base64 blob; bounding it
 * keeps the "a misconfigured run can NEVER send an unbounded payload" promise
 * true for the screenshot lever too (not just `elementsText`).
 */
const MAX_NAV_SCREENSHOT_CHARS = 1_500_000;

/** Hard char cap for the accessibility tree, a second large per-step payload. */
const MAX_NAV_AXTREE_CHARS = 200_000;

/**
 * Prepare the navigator request for the current step: optionally run the
 * HTML-summarizer pre-pass, build the AgentStepRequest, and append the
 * post-observe captcha/downloads nudges to `pendingLoopWarning`.
 *
 * Returns the prepared request. Clears `state.pendingLoopWarning` after
 * consuming it.
 */
export async function prepareNavigatorRequest(
  state: LoopState,
  browserState: BrowserState
): Promise<AgentStepRequest> {
 // Opt-in HTML-summarizer pre-pass.
  let navElementsText = browserState.elementsText;
  if (state.config.enableHtmlSummarizer && browserState.elementsText.length > DEFAULT_MIN_HTML_LENGTH) {
    try {
      const summary = summarizeDom({
        task: state.task,
        currentGoal: state.currentGoal,
        elements: browserState.elements,
      });
      if (!summary.fellBack && summary.keptElements.length > 0) {
        navElementsText = renderElementsText(summary.keptElements);
        state.onEvent({ type: "info", message: summary.summary });
      }
    } catch (e) {
      state.onEvent({
        type: "info",
        message: `HTML summarizer skipped: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

 // Hard cap applied REGARDLESS of the summarizer path: whether the summarizer
 // is disabled, or it ran but fell back to the full DOM (low keyword
 // coverage), `navElementsText` must never exceed `MAX_NAV_ELEMENTS_TEXT_CHARS`.
 // Returning the full DOM on fallback would pay full-DOM token cost for zero
 // savings; truncating bounds the worst case deterministically.
  if (navElementsText.length > MAX_NAV_ELEMENTS_TEXT_CHARS) {
    state.onEvent({
      type: "info",
      message:
        `Navigator DOM truncated to ${MAX_NAV_ELEMENTS_TEXT_CHARS} chars ` +
        `(raw/fallback was ${navElementsText.length}).`,
    });
    navElementsText = navElementsText.slice(0, MAX_NAV_ELEMENTS_TEXT_CHARS);
  }

 // Bound the other two large per-step payloads (vision screenshot + a11y tree)
 // so the "never an unbounded payload" guarantee holds for them as well.
  let screenshot = browserState.screenshot;
  if (screenshot && screenshot.length > MAX_NAV_SCREENSHOT_CHARS) {
    state.onEvent({
      type: "info",
      message:
        `Navigator screenshot dropped (${screenshot.length} chars exceeds ` +
        `the ${MAX_NAV_SCREENSHOT_CHARS}-char cap) to bound vision-token cost.`,
    });
    screenshot = undefined;
  }
  let axTree = browserState.axTree;
  if (axTree && axTree.length > MAX_NAV_AXTREE_CHARS) {
    state.onEvent({
      type: "info",
      message:
        `Navigator axTree truncated to ${MAX_NAV_AXTREE_CHARS} chars ` +
        `(was ${axTree.length}).`,
    });
    axTree = axTree.slice(0, MAX_NAV_AXTREE_CHARS);
  }

  const navRequest: AgentStepRequest = {
    task: state.task,
    history: state.navigatorHistory,
    currentGoal: state.currentGoal,
    plan: state.plan,
    currentPlanItem: state.currentPlanItem,
    browserState: {
      url: browserState.url, title: browserState.title, tabs: browserState.tabs,
      elementsText: navElementsText, pageInfo: browserState.pageInfo,
      newElementCount: browserState.newElementCount,
      screenshot,
      axTree,
    },
    step: state.step,
    maxSteps: state.config.maxSteps,
    loopWarning: state.pendingLoopWarning,
    compactedMemory: state.compactedMemory,
  };
 // The loop warning is consumed by this request — clear it.
  state.pendingLoopWarning = undefined;

  return navRequest;
}

/**
 * Append the post-observe captcha + downloads nudges to the pending loop
 * warning. Called after observeState, before the navigator LLM call.
 */
export function appendPostObserveNudges(
  state: LoopState,
  browserState: { url: string; title: string }
): void {
  const wrapped = buildPostObserveNudges(browserState.url, browserState.title);
  if (wrapped) {
    state.pendingLoopWarning = state.pendingLoopWarning
      ? `${state.pendingLoopWarning}\n${wrapped}`
      : wrapped;
  }
}

/**
 * Run the anti-bot challenge detection + resolution wait.
 *
 * Returns `true` if a challenge was detected (and either resolved or surfaced
 * as a takeover); `false` if no challenge was detected. The caller re-observes
 * the page after a resolved challenge.
 */
export async function runChallengeDetection(
  state: LoopState
): Promise<{ challenge: { kind: string; message: string } | null; resolved: boolean; timedOut: boolean }> {
  if (!state.deps.detectChallenge) {
    return { challenge: null, resolved: false, timedOut: false };
  }
  try {
    const challenge = await state.deps.detectChallenge();
    if (!challenge) {
      return { challenge: null, resolved: false, timedOut: false };
    }
    state.onEvent({
      type: "challenge_detected", step: state.step,
      kind: challenge.kind, message: challenge.message,
    });
    state.onEvent({
      type: "info",
      message: `Anti-bot challenge detected (${challenge.kind}): ${challenge.message}. Pausing while it resolves.`,
    });
    let resolved = false;
    if (state.deps.waitForChallengeResolution) {
      try {
        resolved = await state.deps.waitForChallengeResolution();
      } catch {
        resolved = false;
      }
    }
    return { challenge, resolved, timedOut: !resolved };
  } catch (e) {
    state.onEvent({
      type: "error", step: state.step,
      message: `detectChallenge failed: ${e instanceof Error ? e.message : String(e)}`,
      recoverable: true,
    });
    return { challenge: null, resolved: false, timedOut: false };
  }
}

/**
 * Run the pause check — when `deps.checkPaused` returns true, emit a `paused`
 * event, poll the flag until it clears (or 30-min safety cap / abort), then
 * emit `resumed`.
 */
export async function runPauseCheck(state: LoopState): Promise<void> {
  if (!state.deps.checkPaused) return;
  try {
    let paused = await state.deps.checkPaused();
    if (!paused) return;
    state.onEvent({ type: "paused", step: state.step });
    state.onEvent({
      type: "info",
      message: "Agent paused by user. Click Resume to continue.",
    });
    const PAUSE_POLL_MS = 500;
    const PAUSE_MAX_MS = 30 * 60 * 1000;
    const pauseDeadline = Date.now() + PAUSE_MAX_MS;
 // Track WHY the poll loop ended so we only emit `resumed` when the user
 // actually cleared the pause (not when aborted or when the 30-min safety
 // cap fired while still paused — both must not masquerade as a resume).
    let exitReason: "cleared" | "deadline" | "aborted" = "cleared";
    while (paused && Date.now() < pauseDeadline) {
      if (state.signal?.aborted) {
        exitReason = "aborted";
        break;
      }
      await new Promise<void>((r) => setTimeout(r, PAUSE_POLL_MS));
      try {
        paused = await state.deps.checkPaused!();
      } catch {
 // Transient storage/lookup error — keep the current `paused` value
 // rather than force-resuming. We re-poll on the next iteration (bounded
 // by `pauseDeadline`), so an intermittent failure must NOT silently end
 // an explicit user pause.
      }
    }
 // Re-check abort after the loop in case it fired on the final iteration.
    if (exitReason !== "aborted" && state.signal?.aborted) exitReason = "aborted";
 // If we exited the loop while STILL paused, the 30-min safety cap reached
 // (the `Date.now() < pauseDeadline` condition went false) — mark it so we
 // emit the distinct "safety cap reached" message instead of a misleading
 // "resumed". This assignment was dropped in the reconcile rewrite, which
 // made the `=== "deadline"` branch unreachable (TS2367).
    if (exitReason !== "aborted" && paused) exitReason = "deadline";

    if (exitReason === "aborted") {
 // Honour the abort: emit no misleading "resumed" event. The orchestrator's
 // top-of-step abort check will exit the run on the next iteration.
      return;
    }
    if (exitReason === "deadline") {
 // Safety cap elapsed while the user is still paused. We must not claim the
 // user resumed, so emit a distinct info message instead of "resumed".
      state.onEvent({
        type: "info",
        message: "Pause safety cap (30 min) reached while still paused — continuing.",
      });
      return;
    }
    state.onEvent({ type: "resumed", step: state.step });
    state.onEvent({ type: "info", message: "Agent resumed." });
  } catch (e) {
 // Pause check is best-effort — never crash the loop — but a genuine storage
 // failure (the initial `checkPaused()` or the poll loop) must be observable
 // rather than silently swallowed, so the loop doesn't proceed as if the user
 // never paused.
    state.onEvent({
      type: "error",
      step: state.step,
      message: `pause check failed: ${e instanceof Error ? e.message : String(e)}`,
      recoverable: true,
    });
  }
}
