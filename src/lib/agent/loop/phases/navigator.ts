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
      screenshot: browserState.screenshot,
      axTree: browserState.axTree,
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
    while (paused && Date.now() < pauseDeadline) {
      if (state.signal?.aborted) break;
      await new Promise<void>((r) => setTimeout(r, PAUSE_POLL_MS));
      try {
        paused = await state.deps.checkPaused!();
      } catch {
        paused = false;
      }
    }
    state.onEvent({ type: "resumed", step: state.step });
    state.onEvent({ type: "info", message: "Agent resumed." });
  } catch {
    // Pause check is best-effort — never crash the loop.
  }
}
