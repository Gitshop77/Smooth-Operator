/**
 * Context injection points.
 *
 * Pure functions that each return a nudge string (or `null`) based on the
 * current {@link LoopState} + browser state. The injection flow is split into
 * two entry points (there is no single "block builder" — the docstring
 * formerly called it `buildInjectionBlock`, which does not exist):
 *
 *   - {@link buildPreObserveNudges} runs the six pre-observe nudges (budget,
 *     cost-budget, replan, exploration, loop-detection, force-done) and
 *     concatenates the non-null results into a single `<sys>` block prepended
 *     to the next navigator request BEFORE `observeState`.
 *   - {@link buildPostObserveNudges} runs the two URL-dependent nudges
 *     (captcha-wait, downloads-check) AFTER `observeState`.
 */

import type { LoopState, StepInfo } from "../types";
import { LoopDetector } from "../loop-detector";
import {
  BUDGET_WARNING_FRACTION,
  REPLAN_NUDGE_FAILURES,
  EXPLORATION_NUDGE_STEPS,
  CAPTCHA_URL_HINTS,
  DOWNLOAD_URL_HINTS,
} from "../constants";

/** Returns `true` when `stepNumber` is the final step (no further steps remain). */
export function isLastStep(stepInfo: StepInfo): boolean {
  return stepInfo.stepNumber >= stepInfo.maxSteps - 1;
}

/**
 * 1. Budget warning — fires once when the step count crosses 75% of the
 *    budget. Returns the warning text (or `null` when below the threshold).
 */
export function injectBudgetWarning(stepInfo: StepInfo): string | null {
  const stepsUsed = stepInfo.stepNumber + 1;
  const ratio = stepsUsed / stepInfo.maxSteps;
  if (ratio < BUDGET_WARNING_FRACTION) return null;
  if (isLastStep(stepInfo)) return null; // last step uses force-done instead
  const remaining = stepInfo.maxSteps - stepsUsed;
  const pct = Math.floor(ratio * 100);
  return (
    `BUDGET WARNING: You have used ${stepsUsed}/${stepInfo.maxSteps} steps (${pct}%). ` +
    `${remaining} steps remaining. ` +
    `If the task cannot be completed in the remaining steps, prioritize: ` +
    `(1) consolidate your results (save to files if the file system is in use), ` +
    `(2) call done with what you have. ` +
    `Partial results are far more valuable than exhausting all steps with nothing saved.`
  );
}

/**
 * 1b. Cost-cap budget warning — fires when the cumulative USD cost crosses the
 *     configured fraction (default 75%) of the cost cap.
 */
export function injectCostBudgetWarning(
  totalCostUsd: number,
  costCapUsd: number | undefined,
  fraction: number = BUDGET_WARNING_FRACTION
): string | null {
  if (costCapUsd === undefined || costCapUsd <= 0) return null;
  if (fraction <= 0 || fraction > 1) return null;
  const ratio = totalCostUsd / costCapUsd;
  if (ratio < fraction) return null;
  const pct = Math.floor(ratio * 100);
  const remaining = Math.max(0, costCapUsd - totalCostUsd);
  return (
    `COST BUDGET WARNING: You have used $${totalCostUsd.toFixed(4)} of $${costCapUsd.toFixed(4)} (${pct}%). ` +
    `$${remaining.toFixed(4)} remaining before the run is hard-stopped. ` +
    `If the task cannot be completed within the remaining budget, prioritize: ` +
    `(1) consolidate your results, ` +
    `(2) call done with what you have. ` +
    `Partial results are far more valuable than hitting the cost cap with nothing saved.`
  );
}

/**
 * 2. Replan nudge — fires when `consecutiveFailures` reaches the threshold
 *    (default 3) AND a plan exists.
 */
export function injectReplanNudge(
  consecutiveFailures: number,
  hasPlan: boolean,
  threshold: number = REPLAN_NUDGE_FAILURES
): string | null {
  if (!hasPlan) return null;
  if (threshold <= 0) return null;
  if (consecutiveFailures < threshold) return null;
  return (
    `REPLAN SUGGESTED: You have failed ${consecutiveFailures} consecutive times. ` +
    `Your current plan may need revision. Try a different approach or call done(success=false) if truly stuck.`
  );
}

/**
 * 3. Exploration nudge — fires when the step count reaches the threshold
 *    (default 5) AND no plan exists yet.
 */
export function injectExplorationNudge(
  step: number,
  hasPlan: boolean,
  threshold: number = EXPLORATION_NUDGE_STEPS
): string | null {
  if (hasPlan) return null;
  if (threshold <= 0) return null;
  if (step < threshold) return null;
  return (
    `PLANNING NUDGE: You have taken ${step + 1} steps without creating a plan. ` +
    `If the task is complex, break it down into smaller steps. ` +
    `If the task is already done or nearly done, call done instead.`
  );
}

/**
 * 4. Loop-detection nudge — wraps {@link LoopDetector.shouldWarn}.
 */
export function injectLoopDetectionNudge(detector: LoopDetector): string | null {
  const count = detector.shouldWarn();
  if (count === 0) return null;
  return LoopDetector.warningText(count);
}

/**
 * 5. Force-done after last step — returns the force-done message when
 *    `stepInfo` is the final step, else `null`.
 */
export function forceDoneAfterLastStep(stepInfo: StepInfo): string | null {
  if (!isLastStep(stepInfo)) return null;
  return (
    `You reached max_steps - this is your last step. Your only tool available is the "done" tool. ` +
    `No other tool is available. All other tools which you see in history or examples are not available.\n` +
    `If the task is not yet fully finished as requested by the user, set success in "done" to false!\n` +
    `Include everything you found out for the ultimate task in the done text.`
  );
}

/**
 * 6. Force-done after failure — returns the force-done message when
 *    `consecutiveFailures` reaches `maxFailures`, else `null`.
 */
export function forceDoneAfterFailure(
  consecutiveFailures: number,
  maxFailures: number
): string | null {
  if (maxFailures <= 0) return null;
  if (consecutiveFailures < maxFailures) return null;
  return (
    `You failed ${maxFailures} times. Therefore we terminate the agent.\n` +
    `Your only tool available is the "done" tool. No other tool is available.\n` +
    `If the task is not yet fully finished as requested by the user, set success in "done" to false!`
  );
}

/**
 * 7. Captcha-wait nudge — returns a nudge string when the page URL or title
 *    suggests a captcha is being shown.
 */
export function injectCaptchaWaitNudge(url: string, title: string = ""): string | null {
  const hay = `${url}\n${title}`.toLowerCase();
  if (!CAPTCHA_URL_HINTS.some((h) => hay.includes(h))) return null;
  return (
    `CAPTCHA DETECTED: this page appears to be showing a captcha challenge. ` +
    `Do NOT attempt to solve it programmatically — call the "takeover" action ` +
    `with reason="captcha" so the user can solve it manually, then the run will resume.`
  );
}

/**
 * 8. Downloads-check nudge — returns a nudge string when the page URL suggests
 *    a download is in progress.
 */
export function injectDownloadsCheckNudge(url: string): string | null {
  const lower = url.toLowerCase();
  if (!DOWNLOAD_URL_HINTS.some((h) => lower.includes(h))) return null;
  return (
    `DOWNLOAD DETECTED: this URL appears to be a downloadable file (${url.slice(-40)}). ` +
    `If a download has started, wait for it to complete before navigating away. ` +
    `If the browser is showing a download prompt, accept it; otherwise call done with the file path.`
  );
}

/**
 * Run pre-observe injection points (6 nudges that don't depend on the
 * page URL). Used by the orchestrator BEFORE `observeState`.
 */
export function buildPreObserveNudges(state: LoopState): string | null {
  const stepInfo: StepInfo = { stepNumber: state.step, maxSteps: state.config.maxSteps };
  const nudges: string[] = [];
  // Fire the budget warnings only ONCE per run (not every step from 75% to
  // maxSteps-2). Re-injecting on every step would bloat the context window
  // with ~60 lines of repeated warnings over a 50-step run.
  if (!state.budgetWarningFired) {
    const budget = injectBudgetWarning(stepInfo);
    if (budget) {
      nudges.push(budget);
      state.budgetWarningFired = true;
    }
  }
  if (!state.costBudgetWarningFired) {
    const costBudget = injectCostBudgetWarning(state.totalCostUsd, state.config.costCapUsd);
    if (costBudget) {
      nudges.push(costBudget);
      state.costBudgetWarningFired = true;
    }
  }
  const replan = injectReplanNudge(state.consecutiveFailures, !!state.plan);
  if (replan) nudges.push(replan);
  const exploration = injectExplorationNudge(state.step, !!state.plan);
  if (exploration) nudges.push(exploration);
  const loop = injectLoopDetectionNudge(state.loopDetector);
  if (loop) nudges.push(loop);
  const lastStep = forceDoneAfterLastStep(stepInfo);
  if (lastStep) nudges.push(lastStep);
  const failure = forceDoneAfterFailure(state.consecutiveFailures, state.config.maxFailures);
  if (failure) nudges.push(failure);
  if (nudges.length === 0) return null;
  return `<sys>\n${nudges.join("\n")}\n</sys>`;
}

/**
 * Run post-observe injection points (2 nudges that depend on the page URL).
 * Used by the orchestrator AFTER `observeState`.
 */
export function buildPostObserveNudges(url: string, title: string): string | null {
  const nudges: string[] = [];
  const captcha = injectCaptchaWaitNudge(url, title);
  if (captcha) nudges.push(captcha);
  const downloads = injectDownloadsCheckNudge(url);
  if (downloads) nudges.push(downloads);
  if (nudges.length === 0) return null;
  return `<sys>\n${nudges.join("\n")}\n</sys>`;
}
