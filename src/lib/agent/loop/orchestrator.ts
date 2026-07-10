/**
 * The agentic loop orchestrator — Planner + Navigator duo.
 *
 * Architecture:
 *   1. PLANNER runs first (and every N navigator steps) to decompose the
 *      task into a plan and give the navigator a concrete `next_goal`.
 *   2. NAVIGATOR runs for up to N steps, executing actions toward `next_goal`.
 *   3. After N navigator steps (or when the navigator emits `done`), PLANNER
 *      runs again to evaluate progress, update the plan, or call done.
 *   4. ONLY the planner can call `done(success=true)`. The navigator's `done`
 *      is treated as "I think I'm done, planner please verify".
 */

import type {
  ActionResult,
  AgentOutput,
  PlannerOutput,
} from "../types";
import { DEFAULT_CONFIG } from "../types";
import { classifyError, friendlyErrorMessage } from "../errors";
import { LoopDetector } from "./loop-detector";
import { earlyStop, DEFAULT_EARLY_STOP_THRESHOLDS } from "./early-stop";
import { shouldCompact } from "./compaction";
import { CallbackDispatcher } from "../callbacks";

// ─── Local imports for the coordinator ──────────────────────────────────────

import type { LoopDeps, LoopState } from "./types";
import { BUDGET_WARNING_FRACTION } from "./constants";
import { buildPreObserveNudges } from "./context/injection-points";
import {
  runPlanner,
  callNavigatorWithRetry,
  executeActionQueue,
  runCompaction,
  waitForTakeoverResume,
  maybeJudgeAndFinalize,
  makeCtx,
  addCost,
  addTokens,
  costCapExceeded,
  buildRunResult,
} from "./helpers";
import { observeState } from "./phases/observe-state";
import {
  handleNavigatorDone,
  runPeriodicPlannerCheck,
} from "./phases/planner-phases";
import {
  prepareNavigatorRequest,
  appendPostObserveNudges,
  runChallengeDetection,
  runPauseCheck,
} from "./phases/navigator";

/** Sleep helper. */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─── The orchestrator ────────────────────────────────────────────────────────

/**
 * Run the full Planner + Navigator agent loop until the task completes, the
 * step budget is exhausted, the cost cap is reached, the user aborts, or a
 * fatal error occurs. All progress is streamed via `deps.onEvent`.
 *
 * The function NEVER throws — all errors are classified and surfaced as
 * `done` or `error` events.
 */
export async function runAgentLoop(deps: LoopDeps): Promise<void> {
  try {
    await runAgentLoopInner(deps);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    try {
      deps.onEvent({
        type: "done",
        step: 0,
        success: false,
        text: `Uncaught error in agent loop: ${message}`,
      });
    } catch {
      // If onEvent itself throws, there's nothing we can do — swallow.
    }
  }
}

/** Inner implementation — does the real work; outer wrapper catches any throw. */
async function runAgentLoopInner(deps: LoopDeps): Promise<void> {
  // Merge user config over defaults, then validate via the Zod schema.
  // validateConfig fills in defaults + catches invalid values (negative maxSteps,
  // etc.) at the boundary. If validation fails, fall back to the plain merge
  // (backward-compatible — the orchestrator never throws on bad config).
  let config: import("../types").AgentConfig;
  try {
    const { validateConfig } = await import("../config");
    config = validateConfig({ ...DEFAULT_CONFIG, ...deps.config });
  } catch {
    config = { ...DEFAULT_CONFIG, ...deps.config };
  }
  const settleDelay = deps.settleDelayMs ?? 500;

  let dispatcher: CallbackDispatcher | undefined;
  if (deps.callbacks && deps.callbacks.length > 0) {
    dispatcher = new CallbackDispatcher();
    for (const h of deps.callbacks) dispatcher.register(h);
  }

  const state: LoopState = {
    deps,
    config,
    task: deps.task,
    onEvent: deps.onEvent,
    signal: deps.signal,
    settleDelay,
    navigatorHistory: [],
    loopDetector: new LoopDetector(),
    plan: undefined,
    currentPlanItem: undefined,
    step: 0,
    navigatorStepsSincePlanner: 0,
    consecutiveFailures: 0,
    consecutiveParseFailures: 0,
    totalCostUsd: 0,
    totalTokensIn: 0,
    totalTokensOut: 0,
    lastCompactionStep: undefined,
    compactedMemory: undefined,
    pendingLoopWarning: undefined,
    budgetWarningFired: false,
    costBudgetWarningFired: false,
    currentGoal: deps.task,
    dispatcher,
  };

  const { task, onEvent, signal } = state;

  onEvent({ type: "run-start", task, maxSteps: config.maxSteps });
  if (dispatcher) await dispatcher.runStart(makeCtx(state));

  // ── Phase 1: initial planner call ──────────────────────────────────────
  let plannerResult: PlannerOutput;
  try {
    const initialTabs = await deps.getTabs();
    const initialUrl = initialTabs.find((t) => t.active)?.url ?? initialTabs[0]?.url ?? "";
    plannerResult = await runPlanner(
      deps,
      {
        task, navigatorHistory: state.navigatorHistory, plan: state.plan,
        currentPlanItem: state.currentPlanItem,
        url: initialUrl, tabs: initialTabs, step: state.step,
        maxSteps: config.maxSteps,
        onCost: (usd, tokensIn, tokensOut) => {
          addCost(state, usd);
          addTokens(state, tokensIn, tokensOut);
        },
      },
      dispatcher,
      makeCtx(state)
    );
  } catch (e) {
    const isAbort = deps.signal?.aborted || (e instanceof Error && /abort/i.test(e.name));
    let doneText: string;
    if (isAbort) {
      onEvent({ type: "info", message: "Agent stopped by user." });
      doneText = "Agent stopped by user.";
      onEvent({ type: "done", step: 0, success: false, text: doneText });
    } else {
      const rawMsg = e instanceof Error ? e.message : String(e);
      if (/^Budget exceeded:/i.test(rawMsg)) {
        doneText = rawMsg;
        onEvent({ type: "done", step: 0, success: false, text: doneText });
      } else {
        const isRateLimit = /429|too many requests|rate limit/i.test(rawMsg);
        doneText = isRateLimit
          ? "The LLM provider is rate-limiting requests. Wait a few seconds and try again."
          : `Initial planner call failed: ${rawMsg}`;
        onEvent({
          type: "error", step: 0,
          message: isRateLimit ? `Rate limited: ${rawMsg}` : `Planner failed: ${rawMsg}`,
          recoverable: isRateLimit,
        });
        onEvent({ type: "done", step: 0, success: false, text: doneText });
      }
    }
    if (dispatcher) await dispatcher.runEnd(buildRunResult(state, false, doneText));
    return;
  }

  if (costCapExceeded(state)) {
    if (dispatcher) await dispatcher.runEnd(buildRunResult(state, false, `Cost cap of $${config.costCapUsd} reached.`));
    return;
  }

  if (plannerResult.decision === "web_task") {
    const text = plannerResult.text || "";
    onEvent({ type: "done", step: 0, success: true, text });
    if (dispatcher) await dispatcher.runEnd(buildRunResult(state, true, text));
    return;
  }
  if (plannerResult.decision === "done") {
    const finalized = await maybeJudgeAndFinalize(
      deps,
      config,
      {
        step: 0,
        success: !!plannerResult.success,
        text: plannerResult.text || "",
        navigatorHistory: state.navigatorHistory,
        onCost: (usd, tokensIn, tokensOut) => {
          addCost(state, usd);
          addTokens(state, tokensIn, tokensOut);
        },
      },
      state,
      dispatcher,
      makeCtx(state)
    );
    if (finalized) {
      if (dispatcher) await dispatcher.runEnd(buildRunResult(state, !!plannerResult.success, plannerResult.text || ""));
      return;
    }
  }
  state.plan = plannerResult.plan;
  state.currentPlanItem = plannerResult.current_plan_item ?? 0;
  state.currentGoal = plannerResult.next_goal || (state.plan && state.plan[state.currentPlanItem]) || task;
  onEvent({
    type: "planner-step", step: state.step, decision: plannerResult.decision,
    goal: state.currentGoal, plan: state.plan,
  });
  if (dispatcher) {
    await dispatcher.plannerStep(makeCtx(state), plannerResult.decision, state.currentGoal, state.plan);
  }

  // ── Phase 2: navigator loop ────────────────────────────────────────────
  while (state.step < config.maxSteps) {
    if (signal?.aborted) {
      onEvent({ type: "info", message: "Agent stopped by user." });
      const doneText = "Agent stopped by user.";
      onEvent({ type: "done", step: state.step, success: false, text: doneText });
      if (dispatcher) await dispatcher.runEnd(buildRunResult(state, false, doneText));
      return;
    }
    if (costCapExceeded(state)) {
      if (dispatcher) await dispatcher.runEnd(buildRunResult(state, false, `Cost cap of $${config.costCapUsd} reached.`));
      return;
    }

    // Budget warning fires once, when step reaches the configured fraction of
    // maxSteps. `Math.max(1, ...)` guards the small-`maxSteps` edge case
    // (e.g. maxSteps=1 → floor(0.75)=0 → warning would fire at step 0 before
    // any navigator step had run). With the floor at 1, the warning either
    // fires at step 1+ (a meaningful "75% used" point) or never fires at all
    // when maxSteps is so small the threshold lands outside the loop range.
    const budgetWarnStep = Math.max(1, Math.floor(config.maxSteps * BUDGET_WARNING_FRACTION));
    if (state.step === budgetWarnStep) {
      onEvent({ type: "budget-warning", step: state.step, pct: Math.floor(BUDGET_WARNING_FRACTION * 100) });
    }

    const preObserveNudges = buildPreObserveNudges(state);
    if (preObserveNudges) {
      state.pendingLoopWarning = state.pendingLoopWarning
        ? `${state.pendingLoopWarning}\n${preObserveNudges}`
        : preObserveNudges;
    }

    onEvent({ type: "navigator-step-start", step: state.step });
    if (dispatcher) await dispatcher.stepStart(makeCtx(state));

    const observed = await observeState(state);
    if (observed.status === "error") {
      onEvent({
        type: "error", step: state.step,
        message: observed.message,
        recoverable: true,
      });
      if (dispatcher) await dispatcher.error(makeCtx(state), observed.message, true);
      state.consecutiveFailures++;
      if (state.consecutiveFailures >= config.maxFailures) {
        const doneText = `Agent aborted after ${config.maxFailures} consecutive failures (${observed.phase}).`;
        onEvent({ type: "done", step: state.step, success: false, text: doneText });
        if (dispatcher) await dispatcher.runEnd(buildRunResult(state, false, doneText));
        return;
      }
      state.step++;
      continue;
    }
    // `tabs` is declared with `let` so the challenge-re-observe branch below
    // can refresh it. `browserState` is mutated in place via
    // `Object.assign` so `const` is fine for it.
    const { state: browserState, tabs: initialTabs } = observed;
    let tabs = initialTabs;
    state.lastObservedUrl = browserState.url;

    onEvent({
      type: "state", step: state.step, url: browserState.url, elementCount: browserState.elements.length,
      newElementCount: browserState.newElementCount, pageInfo: browserState.pageInfo,
    });
    if (config.enableLoopDetection) {
      try {
        await state.loopDetector.recordPageState(
          browserState.url,
          browserState.elementsText,
          browserState.elements.length,
        );
        const stagnantCount = state.loopDetector.shouldWarnStagnant();
        if (stagnantCount > 0) {
          state.pendingLoopWarning = state.pendingLoopWarning
            ? `${state.pendingLoopWarning}\n${LoopDetector.stagnantWarningText(stagnantCount)}`
            : LoopDetector.stagnantWarningText(stagnantCount);
          onEvent({ type: "loop-warning", step: state.step, count: stagnantCount });
        }
      } catch {
        // Page-fingerprint hashing is best-effort — never block the loop.
      }
    }
    if (browserState.screenshot && dispatcher) {
      await dispatcher.screenshot(makeCtx(state), browserState.screenshot);
    }

    appendPostObserveNudges(state, browserState);

    // Challenge detection + pause check
    const challengeResult = await runChallengeDetection(state);
    if (challengeResult.challenge) {
      if (challengeResult.timedOut) {
        const resumeResult = await waitForTakeoverResume(
          deps, `Anti-bot challenge (${challengeResult.challenge.kind}): ${challengeResult.challenge.message}`, state.step,
        );
        if (resumeResult === "timeout") {
          const doneText = `Timed out waiting for anti-bot challenge to resolve.`;
          onEvent({ type: "done", step: state.step, success: false, text: doneText });
          if (dispatcher) await dispatcher.runEnd(buildRunResult(state, false, doneText));
          return;
        }
      }
      // Re-observe the page after the challenge cleared / user resumed.
      const reObserved = await observeState(state);
      if (reObserved.status === "error") {
        onEvent({
          type: "error", step: state.step,
          message: `Re-observe after challenge failed: ${reObserved.message}`,
          recoverable: true,
        });
        state.step++;
        continue;
      }
      Object.assign(browserState, reObserved.state);
      // Refresh the captured `tabs` reference too — the challenge branch
      // re-observed the page, so the tab list may have changed (Cloudflare
      // redirects, login flows opening new tabs, …).
      tabs = reObserved.tabs;
      // Emit a `resumed` event so the side panel hides the takeover banner
      // that was shown by `challenge_detected`.
      onEvent({ type: "resumed", step: state.step });
      onEvent({ type: "info", message: `Anti-bot challenge cleared — resuming.` });
    }

    await runPauseCheck(state);

    // ── 2b. Reason: call navigator LLM (with parse retry) ──
    const navRequest = await prepareNavigatorRequest(state, browserState);

    let output: AgentOutput;
    try {
      output = await callNavigatorWithRetry(
        deps, navRequest, state.step, (usd, tokensIn, tokensOut) => {
          addCost(state, usd);
          addTokens(state, tokensIn, tokensOut);
        },
        dispatcher, makeCtx(state)
      );
      state.consecutiveParseFailures = 0;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/^Budget exceeded:/i.test(msg)) {
        onEvent({ type: "done", step: state.step, success: false, text: msg });
        if (dispatcher) await dispatcher.runEnd(buildRunResult(state, false, msg));
        return;
      }
      const classified = classifyError(e);
      const willExceed = (state.consecutiveFailures + 1) >= config.maxFailures;
      onEvent({
        type: "error",
        step: state.step,
        message: friendlyErrorMessage(classified),
        recoverable: !classified.fatal && !willExceed,
      });
      if (dispatcher) {
        await dispatcher.error(makeCtx(state), friendlyErrorMessage(classified), !classified.fatal && !willExceed);
      }
      if (classified.fatal) {
        const doneText = `Fatal error (${classified.category}): ${classified.message}`;
        onEvent({ type: "done", step: state.step, success: false, text: doneText });
        if (dispatcher) await dispatcher.runEnd(buildRunResult(state, false, doneText));
        return;
      }
      if (classified.category === "cancelled") {
        onEvent({ type: "info", message: "Agent stopped by user." });
        const doneText = "Agent stopped by user.";
        onEvent({ type: "done", step: state.step, success: false, text: doneText });
        if (dispatcher) await dispatcher.runEnd(buildRunResult(state, false, doneText));
        return;
      }
      state.consecutiveFailures++;
      if (/\b(parse|unparseable)\b/i.test(msg)) {
        state.consecutiveParseFailures++;
      }
      if (state.consecutiveFailures >= config.maxFailures) {
        const doneText = `Agent aborted after ${config.maxFailures} consecutive failures. Last error: ${classified.message}`;
        onEvent({ type: "done", step: state.step, success: false, text: doneText });
        if (dispatcher) await dispatcher.runEnd(buildRunResult(state, false, doneText));
        return;
      }
      if (config.enableEarlyStop) {
        const es = earlyStop(
          state.navigatorHistory,
          state.consecutiveParseFailures,
          config.earlyStopThresholds ?? DEFAULT_EARLY_STOP_THRESHOLDS,
        );
        if (es.stop) {
          const doneText = `Early-stop: ${es.reason}`;
          onEvent({ type: "done", step: state.step, success: false, text: doneText });
          if (dispatcher) await dispatcher.runEnd(buildRunResult(state, false, doneText));
          return;
        }
      }
      state.step++;
      continue;
    }

    if (costCapExceeded(state)) {
      if (dispatcher) await dispatcher.runEnd(buildRunResult(state, false, `Cost cap of $${config.costCapUsd} reached.`));
      return;
    }

    onEvent({
      type: "thinking", step: state.step, text: output.thinking,
      evaluation: output.evaluation_previous_goal, memory: output.memory, nextGoal: output.next_goal,
    });
    if (dispatcher) {
      await dispatcher.thinking(
        makeCtx(state), output.thinking, output.evaluation_previous_goal, output.memory, output.next_goal
      );
    }

    if (output.action.length > config.maxActionsPerStep) {
      const truncMsg = `Navigator emitted ${output.action.length} actions (max ${config.maxActionsPerStep}); truncating.`;
      onEvent({ type: "error", step: state.step, message: truncMsg, recoverable: true });
      if (dispatcher) await dispatcher.error(makeCtx(state), truncMsg, true);
    }
    // F2: preserve a sole `done` action even when the navigator emitted more
    // actions than maxActionsPerStep. The `done` action always means "stop and
    // finalize" (F-18 enforces it is the sole action at parse time), so if it
    // is present we run ONLY it and discard the rest rather than truncating `done`
    // off the end of the queue.
    const soleDoneAction = output.action.find((a) => a.type === "done");
    const actions = soleDoneAction ? [soleDoneAction] : output.action.slice(0, config.maxActionsPerStep);

    const doneAction = actions.find((a) => a.type === "done");

    if (doneAction && doneAction.type === "done") {
      // F-18 is enforced at PARSE TIME (the AgentOutputSchema.action
      // superRefine): a step that pairs `done` with a sibling action is
      // rejected before it reaches the orchestrator, so `doneAction` is
      // ALWAYS the sole action in the step. The previous sibling-
      // execution branch is therefore dead code and has been removed —
      // we finalize immediately (preserving the single-`done` behavior).
      const result = await handleNavigatorDone(state, doneAction, output, browserState, tabs);
      if (result.finalized) {
        if (dispatcher) await dispatcher.runEnd(buildRunResult(state, false, ""));
        return;
      }
      // Fire stepEnd for the done step so metrics are accurate.
      if (dispatcher) await dispatcher.stepEnd(makeCtx(state), [{ action: doneAction, success: doneAction.success ?? true, message: `Navigator requested completion: ${doneAction.text}`, isDone: true }]);
      continue;
    }

    // Execute the action queue
    const agentMode = deps.mode ?? "standard";
    let results: ActionResult[];
    if (deps.executeActions) {
      try {
        // The `deps.executeActions` override (always set in the extension
        // path — see run-helpers.ts) bypasses `executeActionQueue`, which is
        // the only caller of `loopDetector.record(action, step)`. Without
        // recording here, the action-repetition loop detector would be dead
        // code in production — only the page-fingerprint detector
        // (`recordPageState` above) would fire. Record each action in the
        // batch here so the rolling FNV-1a hash window detects repeated
        // action sequences (e.g. click→scroll→click→scroll) even when the
        // page fingerprint hasn't changed. The per-action
        // `loopDetector.reset()` on page-change (action-queue.ts:131,153) is
        // approximated by a single post-batch reset below — the override
        // contract returns batch results, not per-action page-change events,
        // so mid-batch resets aren't possible without refactoring the
        // contract. The page-fingerprint detector still resets per step.
        if (config.enableLoopDetection) {
          // Check `shouldWarn` AFTER EACH `record`, not once at the end.
          // `shouldWarn` only examines the LAST action's hash count — checking
          // once after the whole batch would miss a repeated action earlier in
          // the batch (e.g. [click×5, scroll] → shouldWarn checks scroll,
          // count=1, no warning — but click has count=5). Matches
          // action-queue.ts:96-103 semantics (per-action record+warn).
          for (const action of actions) {
            state.loopDetector.record(action, state.step);
            const warnCount = state.loopDetector.shouldWarn();
            if (warnCount > 0) {
              onEvent({ type: "loop-warning", step: state.step, count: warnCount });
              if (dispatcher) await dispatcher.loopWarning(makeCtx(state), warnCount);
            }
          }
        }
        results = await deps.executeActions(actions, browserState);
        // Reset the action-repetition window if any action in the batch
        // changed the page — matches action-queue.ts:151-153 semantics.
        if (config.enableLoopDetection && results.some((r) => r.pageChanged)) {
          state.loopDetector.reset();
        }
      } catch (e) {
        const errMsg = `executeActions override failed: ${e instanceof Error ? e.message : String(e)}`;
        onEvent({ type: "error", step: state.step, message: errMsg, recoverable: true });
        if (dispatcher) await dispatcher.error(makeCtx(state), errMsg, true);
        state.consecutiveFailures++;
        if (state.consecutiveFailures >= config.maxFailures) {
          const doneText = `Agent aborted after ${config.maxFailures} consecutive failures (executeActions).`;
          onEvent({ type: "done", step: state.step, success: false, text: doneText });
          if (dispatcher) await dispatcher.runEnd(buildRunResult(state, false, doneText));
          return;
        }
        state.step++;
        continue;
      }
    } else {
      try {
        const queueResult = await executeActionQueue(
          deps, actions, browserState, state.step, agentMode,
          state.loopDetector, config, dispatcher, makeCtx(state)
        );
        results = queueResult.results;
      } catch (e) {
        const errMsg = `executeActionQueue failed: ${e instanceof Error ? e.message : String(e)}`;
        onEvent({ type: "error", step: state.step, message: errMsg, recoverable: true });
        if (dispatcher) await dispatcher.error(makeCtx(state), errMsg, true);
        state.consecutiveFailures++;
        if (state.consecutiveFailures >= config.maxFailures) {
          const doneText = `Agent aborted after ${config.maxFailures} consecutive failures (executeActionQueue).`;
          onEvent({ type: "done", step: state.step, success: false, text: doneText });
          if (dispatcher) await dispatcher.runEnd(buildRunResult(state, false, doneText));
          return;
        }
        state.step++;
        continue;
      }
    }

    if (dispatcher) await dispatcher.stepEnd(makeCtx(state), results);

    // loopWarningCount is emitted as a "loop-warning" event by
    // executeActionQueue; buildInjectionBlock at the next step's start
    // already injects the loop-detection nudge via injectLoopDetectionNudge.
    // Setting pendingLoopWarning here would duplicate the warning.

    // Takeover pause
    const takeoverResult = results.find((r) => r.action.type === "takeover");
    if (takeoverResult) {
      const takeoverAction = takeoverResult.action as { type: "takeover"; reason: string };
      const resumeResult = await waitForTakeoverResume(deps, takeoverAction.reason, state.step);
      if (resumeResult === "timeout") {
        const doneText = "Timed out waiting for user takeover.";
        onEvent({ type: "done", step: state.step, success: false, text: doneText });
        if (dispatcher) await dispatcher.runEnd(buildRunResult(state, false, doneText));
        return;
      }
    }

    // Record history
    state.navigatorHistory.push({
      step: state.step, agent: "navigator",
      evaluation: output.evaluation_previous_goal,
      memory: output.memory, goal: output.next_goal, results,
    });

    // Reset consecutiveFailures only when the MAJORITY of actions succeed (not
    // when ALL succeed — a single benign failure on a step with 5 successful
    // actions shouldn't count as a "consecutive failure"). This prevents
    // premature maxFailures abort on steps with mixed results.
    const failureCount = results.filter((r) => !r.success).length;
    state.consecutiveFailures = failureCount > results.length / 2 ? state.consecutiveFailures + 1 : 0;

    if (config.enableEarlyStop) {
      const es = earlyStop(
        state.navigatorHistory,
        state.consecutiveParseFailures,
        config.earlyStopThresholds ?? DEFAULT_EARLY_STOP_THRESHOLDS,
      );
      if (es.stop) {
        const doneText = `Early-stop: ${es.reason}`;
        // Reflect the actual stop reason's count: parse-failure stops report
        // the parse-failure counter; repeating-action stops report the
        // repeating-action threshold.
        const isParseFailure = es.reason.includes("parse");
        const warnCount = isParseFailure
          ? state.consecutiveParseFailures
          : (config.earlyStopThresholds?.repeatingAction ?? 3);
        onEvent({ type: "loop-warning", step: state.step, count: warnCount });
        onEvent({ type: "done", step: state.step, success: false, text: doneText });
        state.finalResult = { success: false, text: doneText };
        if (dispatcher) await dispatcher.runEnd(buildRunResult(state, false, doneText));
        return;
      }
    }

    // Settle & advance
    try {
      await (deps.waitForSettled?.() ?? sleep(settleDelay));
    } catch (e) {
      const errMsg = `waitForSettled failed: ${e instanceof Error ? e.message : String(e)}`;
      onEvent({ type: "error", step: state.step, message: errMsg, recoverable: true });
      if (dispatcher) await dispatcher.error(makeCtx(state), errMsg, true);
    }
    state.step++;
    state.navigatorStepsSincePlanner++;

    // Compaction check — estimate history size from the last rendered history
    // rather than JSON.stringify on every step (which is O(N²) over the run).
    if (config.enableCompaction) {
      // Quick estimate: average ~500 chars per history item (results +
      // messages). Avoids serializing the full array every step.
      const historyLen = state.navigatorHistory.length * 500;
      const contextBudgetChars = 400_000;
      const approachingContextLimit = historyLen > contextBudgetChars && (state.step - (state.lastCompactionStep ?? 0)) >= 3;
      if (approachingContextLimit) {
        onEvent({
          type: "info", message: `Context approaching limit (${(historyLen / 1000).toFixed(0)}K chars) — triggering early compaction.`,
        });
      }
      if (shouldCompact(
        state.step,
        state.lastCompactionStep,
        historyLen,
        config.compactionStepInterval,
        config.compactionCharThreshold
      ) || approachingContextLimit) {
        let compacted: Awaited<ReturnType<typeof runCompaction>>;
        try {
          compacted = await runCompaction(
            deps,
            state.navigatorHistory,
            state.step,
            (usd, tokensIn, tokensOut) => {
              addCost(state, usd);
              addTokens(state, tokensIn, tokensOut);
            },
            dispatcher,
            makeCtx(state),
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/^Budget exceeded:/i.test(msg)) {
            onEvent({ type: "done", step: state.step, success: false, text: msg });
            if (dispatcher) await dispatcher.runEnd(buildRunResult(state, false, msg));
            state.finalResult = { success: false, text: msg };
            return;
          }
          throw e;
        }
        if (compacted) {
          state.navigatorHistory.length = 0;
          state.navigatorHistory.push(...compacted.keptRecent);
          state.compactedMemory = compacted.compactedMemory;
          state.lastCompactionStep = state.step;
          onEvent({ type: "compaction", step: state.step, compactedCount: compacted.compactedCount });
          if (dispatcher) await dispatcher.compaction(makeCtx(state), compacted.compactedCount);
        }
      }
    }

    // Periodic planner check
    if (state.navigatorStepsSincePlanner >= config.plannerInterval) {
      const result = await runPeriodicPlannerCheck(state, browserState);
      if (result.finalized) {
        if (dispatcher) await dispatcher.runEnd(buildRunResult(state, false, ""));
        return;
      }
    }
  }

  const doneText = `Reached max steps (${config.maxSteps}) without the planner calling done.`;
  onEvent({ type: "done", step: state.step, success: false, text: doneText });
  if (dispatcher) await dispatcher.runEnd(buildRunResult(state, false, doneText));
}
