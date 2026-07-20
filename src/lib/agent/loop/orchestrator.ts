/**
 * The agentic loop orchestrator — Planner + Navigator duo.
 *
 * Architecture:
 * 1. PLANNER runs first (and every N navigator steps) to decompose the
 * task into a plan and give the navigator a concrete `next_goal`.
 * 2. NAVIGATOR runs for up to N steps, executing actions toward `next_goal`.
 * 3. After N navigator steps (or when the navigator emits `done`), PLANNER
 * runs again to evaluate progress, update the plan, or call done.
 * 4. ONLY the planner can call `done(success=true)`. The navigator's `done`
 * is treated as "I think I'm done, planner please verify".
 */

import type {
  ActionResult,
  AgentOutput,
  PlannerOutput,
  LogEvent,
} from "../types";
import { DEFAULT_CONFIG } from "../types";
import { classifyError, friendlyErrorMessage } from "../errors";
import { LoopDetector, LOOP_TOP_THRESHOLD } from "./loop-detector";
import { earlyStop, DEFAULT_EARLY_STOP_THRESHOLDS } from "./early-stop";
import { shouldCompact, renderHistoryForSummarization } from "./compaction";
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

/** Sleep helper. Aborts early if the optional signal fires. */
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Keepalive interval for in-loop awaits. An external watchdog (e.g. the cockpit
 * SSE consumer) uses heartbeat absence to judge a run stale; emitting roughly
 * twice per watchdog window lets it distinguish a busy run from a stalled one.
 */
const HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * Wrap a long-running await (LLM call, compaction, action settle) so a
 * `heartbeat` event is emitted on a fixed interval while it is in flight. The
 * timer is cleared as soon as the wrapped promise settles, so the heartbeat is
 * purely additive — no change to control flow, termination, or any
 * security/injection boundary.
 *
 * The wrapped await is raced against `opts.signal` (a user-stop abort) and an
 * optional `opts.timeoutMs` SLA. If the signal aborts or the SLA elapses
 * while `fn()` is still pending, the race rejects with an AbortError
 * (classified as "cancelled" by `classifyError`) so the surrounding call-site
 * catch — which already mirrors the top-of-loop abort handling — finishes the
 * run. This lets a Stop interrupt an in-flight LLM call that would otherwise
 * hang the run until the provider (never) responds.
 */
function withHeartbeat<T>(
  step: number,
  onEvent: (e: LogEvent) => void,
  fn: (signal?: AbortSignal) => Promise<T>,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<T> {
  const timer = setInterval(() => {
    onEvent({ type: "heartbeat", step, ts: Date.now() });
  }, HEARTBEAT_INTERVAL_MS);

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const cleanup = () => {
    clearInterval(timer);
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (abortHandler && opts?.signal) {
      opts.signal.removeEventListener("abort", abortHandler);
    }
  };

 // Aborting the in-flight LLM call is now done via an internal
 // `AbortController` (declared just below): both the SLA-timeout and the
 // user-abort signal abort `controller`, which is the signal threaded into
 // `fn`. That cancels the underlying `fetch` so a timed-out/stopped step
 // doesn't keep billing the provider in the background.
  // Internal controller that links the user-abort signal AND the SLA timeout.
  // Passing `controller.signal` (rather than the bare user signal) into `fn`
  // means a SLA-timeout firing actually ABORTS the in-flight LLM call (and its
  // underlying `fetch`) instead of leaving it orphaned in the background (HIGH
  // finding: llmCallTimeoutMs SLA did not cancel the in-flight call).
  const controller = new AbortController();
  let timedOut = false;

  // A deliberate abort (SLA timeout or user Stop) cancels the in-flight call via
  // `controller.abort()`. That abort also rejects `fn`'s promise — but the
  // AUTHORITATIVE race rejection should be the timeout/user-abort error (so the
  // orchestrator's classifier sees a "timeout"/"cancelled" exactly as before),
  // not a generic AbortError racing it. Swallow the abort-induced rejection so it
  // cannot win the race; genuine (provider) rejections still propagate.
  const fnPromise = fn(controller.signal);
  const fnWrapped = fnPromise.catch((e: unknown) => {
    if (timedOut || opts?.signal?.aborted) return new Promise<T>(() => {});
    throw e;
  });
  const racers: Promise<T>[] = [fnWrapped];

  const signal = opts?.signal;
  if (signal) {
    if (signal.aborted) {
      controller.abort();
      cleanup();
      return Promise.reject(new DOMException("Aborted by user", "AbortError"));
    }
    let abortReject: (reason: unknown) => void = () => {};
    const abortPromise = new Promise<T>((_, reject) => {
      abortReject = reject;
    });
    abortHandler = () => {
      controller.abort();
      cleanup();
      abortReject(new DOMException("Aborted by user", "AbortError"));
    };
    signal.addEventListener("abort", abortHandler, { once: true });
    racers.push(abortPromise);
  }

  if (opts?.timeoutMs && opts.timeoutMs > 0) {
    racers.push(
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          controller.abort();
          cleanup();
          reject(new DOMException("Step SLA timeout exceeded", "TimeoutError"));
        }, opts.timeoutMs);
      }),
    );
  }

  return Promise.race(racers).finally(cleanup);
}

/** Soft character cap for the rendered navigator history before compaction. */
const CONTEXT_SOFT_CAP_CHARS = 400_000;

// Bounded SLA for the per-step settle wait. A hung `waitForSettled`
// (or a very long jitter-delayed sleep) would otherwise block the loop until
// it naturally resolves; this caps it and lets a user Stop (deps.signal)
// interrupt the settle via withHeartbeat's abort race.
const SETTLE_SLA_MS = 30_000;

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
 // Durable signal for operators: the outer catch only fires for truly
 // uncaught errors (e.g. a thrown config-error bubble or an unexpected
 // throw). Surface it to the SW console so a run failure isn't invisible
 // once the side panel is closed (finding: agent run errors have no durable
 // log or alerting). The SSE `error` event only reaches the side panel.
    console.error("[orchestrator] runAgentLoop uncaught error:", e);
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
 // etc.) at the boundary. If validation fails it THROWS — the run aborts with a
 // clear error rather than silently running on a broken config.
  let config: import("../types").AgentConfig;
  try {
    const { validateConfig } = await import("../config");
    const validatedConfig = validateConfig({ ...DEFAULT_CONFIG, ...deps.config });
 // The Zod schema keeps `enableJudge` OPTIONAL in its output type
 // (`enableJudge: z.boolean().optional()`), so `AgentConfigValidated` has
 // `enableJudge?: boolean`. But `config` is typed `AgentConfig`, which
 // requires `enableJudge: boolean`. The runtime value is always present
 // because `DEFAULT_CONFIG` (merged in first) sets it to `true`, so we
 // re-assert a concrete boolean here. This keeps the shared `AgentConfig`
 // type intact while satisfying the assignment (regression from the
 // reconcile rewrite).
    config = { ...validatedConfig, enableJudge: validatedConfig.enableJudge ?? DEFAULT_CONFIG.enableJudge };
  } catch (e) {
 // `validateConfig` (Zod schema) enforces hard bounds (maxSteps 1–1000,
 // maxActionsPerStep 1–50, maxFailures >= 1, compactionCharThreshold >= 1000).
 // On failure it throws. Do NOT re-merge the SAME unvalidated input — that
 // would silently let out-of-range/malformed values (negative maxSteps,
 // maxActionsPerStep > 50, negative maxFailures) reach the loop logic, making
 // the schema purely decorative (finding: Zod config validation silently
 // discarded / validation failure silently bypassed). Surface the error so
 // the caller/UI gets a clear signal and refuse to start with a broken config.
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[orchestrator] config validation failed:", msg);
 // Preserve structured validation details (e.g. ConfigValidationError.issues)
 // when available, so callers / UI can surface field-level errors instead of
 // only the first message (finding: ConfigValidationError structured details
 // discarded). Re-throw the original error; only synthesize a generic one for
 // non-ConfigValidation errors (duck-type on the `issues` property to avoid a
 // cross-module import).
    if (e instanceof Error && (e as { issues?: unknown }).issues) {
      throw e;
    }
    throw new Error(`Invalid agent configuration: ${msg}`);
  }
  const settleDelay = deps.settleDelay ?? 500;

  let dispatcher: CallbackDispatcher | undefined;
  if (deps.callbacks && deps.callbacks.length > 0) {
    dispatcher = new CallbackDispatcher();
    for (const h of deps.callbacks) dispatcher.register(h);
  }

  /**
 * Safely invoke a user-supplied dispatcher/callback handler. Dispatcher
 * handlers are an externally-supplied extension point; a throwing handler
 * must NOT abort the whole agent loop (finding: user-provided dispatcher/
 * callback exceptions abort the whole run). We log and continue. This also
 * prevents a `runEnd` failure from throwing out of `runAgentLoopInner` and
 * producing a duplicate `done` event via the outer catch.
 */
  const safeDispatch = async (label: string, fn: () => Promise<void>): Promise<void> => {
    if (!dispatcher) return;
    try {
      await fn();
    } catch (e) {
      console.error(`[orchestrator] dispatcher handler "${label}" threw (continuing run):`, e);
    }
  };

  /**
   * Emit the terminal `done` event + `runEnd` dispatcher callback in one place,
   * preserving the event-then-callback ordering used at every finish site.
   */
  const finish = async (success: boolean, text: string): Promise<void> => {
    onEvent({ type: "done", step: state.step, success, text });
    await safeDispatch("runEnd", () => dispatcher!.runEnd(buildRunResult(state, success, text)));
  };

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
  await safeDispatch("runStart", () => dispatcher!.runStart(makeCtx(state)));

 // ── Phase 1: initial planner call ──────────────────────────────────────
  let plannerResult: PlannerOutput;
  try {
    const initialTabs = await deps.getTabs();
    const initialUrl = initialTabs.find((t) => t.active)?.url ?? initialTabs[0]?.url ?? "";
    plannerResult = await withHeartbeat(state.step, onEvent, (signal) => runPlanner(
      deps,
      {
        task, navigatorHistory: state.navigatorHistory, plan: state.plan,
        currentPlanItem: state.currentPlanItem,
        url: initialUrl, tabs: initialTabs, step: state.step,
        maxSteps: config.maxSteps,
        compactedMemory: state.compactedMemory,
        onCost: (usd, tokensIn, tokensOut) => {
          addCost(state, usd);
          addTokens(state, tokensIn, tokensOut);
        },
      },
      dispatcher,
      makeCtx(state),
      signal,
      state.config.costCapUsd,
      () => costCapExceeded(state)
    ), { signal, timeoutMs: config.llmCallTimeoutMs ?? 0 });
  } catch (e) {
    const isAbort = deps.signal?.aborted || (e instanceof Error && (/abort/i.test(e.name) || /abort/i.test(e.message)));
    let doneText: string;
    if (isAbort) {
      onEvent({ type: "info", message: "Agent stopped by user." });
      doneText = "Agent stopped by user.";
    } else {
      const rawMsg = e instanceof Error ? e.message : String(e);
      if (/^Budget exceeded:/i.test(rawMsg)) {
        doneText = rawMsg;
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
      }
    }
    await finish(false, doneText);
    return;
  }

  if (costCapExceeded(state)) {
    await finish(false, `Cost cap of $${config.costCapUsd} reached.`);
    return;
  }

  if (plannerResult.decision === "web_task") {
    const text = plannerResult.text || "";
    await finish(true, text);
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
 // `maybeJudgeAndFinalize` already emitted the authoritative, judge-verified
 // terminal `done` event (and recorded the real outcome in `state.finalResult`).
 // Emitting another `done` here with `plannerResult.success` (the planner's
 // optimistic value, which a judge may have overridden) would duplicate the
 // terminal event and misreport success, so fire only `runEnd` from
 // `state.finalResult` — mirroring the navigator-`done` and periodic-planner
 // finalize sites.
      await safeDispatch("runEnd", () =>
        dispatcher!.runEnd(buildRunResult(state, state.finalResult?.success ?? false, state.finalResult?.text ?? "")),
      );
      return;
    }
  }
  state.plan = plannerResult.plan;
 // Clamp `current_plan_item` to a valid plan index (finding: current_plan_item
 // is accepted without bounds validation). The planner prompt asks for a
 // 0-indexed value < plan.length, but the schema only validates `z.number().int()`,
 // so a negative or out-of-range value must be coerced rather than trusted.
  {
    const cpiRaw = plannerResult.current_plan_item ?? 0;
    const planLen = plannerResult.plan?.length ?? 0;
    const cpi = Number.isInteger(cpiRaw) && cpiRaw >= 0 && cpiRaw < planLen
      ? cpiRaw
      : (cpiRaw < 0 ? 0 : Math.max(0, planLen - 1));
    state.currentPlanItem = cpi;
  }
  state.currentGoal = plannerResult.next_goal || (state.plan && state.plan[state.currentPlanItem]) || task;
  onEvent({
    type: "planner-step", step: state.step, decision: plannerResult.decision,
    goal: state.currentGoal, plan: state.plan,
  });
  if (dispatcher) {
    await safeDispatch("plannerStep", () => dispatcher!.plannerStep(makeCtx(state), plannerResult.decision, state.currentGoal, state.plan));
  }

 // ── Phase 2: navigator loop ────────────────────────────────────────────
 // Budget warning threshold — depends only on constant config values, so
 // compute it once before the loop instead of on every iteration.
 // `Math.max(1, ...)` guards the small-`maxSteps` edge case (e.g. maxSteps=1
 // → floor(0.75)=0 → warning would fire at step 0 before any navigator step
 // had run). With the floor at 1, the warning either fires at step 1+ (a
 // meaningful "75% used" point) or never fires at all when maxSteps is so
 // small the threshold lands outside the loop range.
  const budgetWarnStep = Math.max(1, Math.floor(config.maxSteps * BUDGET_WARNING_FRACTION));
  while (state.step < config.maxSteps) {
    if (signal?.aborted) {
      onEvent({ type: "info", message: "Agent stopped by user." });
      const doneText = "Agent stopped by user.";
      await finish(false, doneText);
      return;
    }
    if (costCapExceeded(state)) {
      await finish(false, `Cost cap of $${config.costCapUsd} reached.`);
      return;
    }

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
    await safeDispatch("stepStart", () => dispatcher!.stepStart(makeCtx(state)));

    const observed = await observeState(state);
    if (observed.status === "error") {
      onEvent({
        type: "error", step: state.step,
        message: observed.message,
        recoverable: true,
      });
      await safeDispatch("error", () => dispatcher!.error(makeCtx(state), observed.message, true));
      state.consecutiveFailures++;
      if (state.consecutiveFailures >= config.maxFailures) {
        const doneText = `Agent aborted after ${config.maxFailures} consecutive failures (${observed.phase}).`;
        await finish(false, doneText);
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
 // Hard-stop once the stagnant-page count reaches the top threshold.
          if (config.enableEarlyStop && stagnantCount >= LOOP_TOP_THRESHOLD) {
            await finish(false, `Loop detected: page state unchanged across ${stagnantCount} snapshots — aborting run.`);
            return;
          }
        }
      } catch (e) {
 // Page-fingerprint hashing is best-effort — never block the loop — but
 // surface failures so the stagnation detector isn't silently dead (e.g. a
 // hidden `crypto.subtle`-unavailable degradation, or a real bug in the
 // fingerprint path). `console.warn` survives the production log-strip, so
 // operational telemetry reflects when stagnation detection is inactive.
        console.warn(
          "[orchestrator] recordPageState failed (stagnation detection may be inactive):",
          e,
        );
      }
    }
    if (browserState.screenshot && dispatcher) {
      const screenshot = browserState.screenshot;
      await safeDispatch("screenshot", () => dispatcher!.screenshot(makeCtx(state), screenshot));
    }

 // Challenge detection + pause check
    const challengeResult = await runChallengeDetection(state);
    if (challengeResult.challenge) {
      if (challengeResult.timedOut) {
        const resumeResult = await waitForTakeoverResume(
          deps, `Anti-bot challenge (${challengeResult.challenge.kind}): ${challengeResult.challenge.message}`, state.step,
        );
        if (resumeResult === "timeout") {
          const doneText = `Timed out waiting for anti-bot challenge to resolve.`;
          await finish(false, doneText);
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

    appendPostObserveNudges(state, browserState);

    await runPauseCheck(state);

 // ── 2b. Reason: call navigator LLM (with parse retry) ──
    const navRequest = await prepareNavigatorRequest(state, browserState);

    let output: AgentOutput;
    try {
      output = await withHeartbeat(state.step, onEvent, (signal) => callNavigatorWithRetry(
        deps, navRequest, state.step, (usd, tokensIn, tokensOut) => {
          addCost(state, usd);
          addTokens(state, tokensIn, tokensOut);
        },
        dispatcher, makeCtx(state), signal, state.config.costCapUsd, () => costCapExceeded(state)
      ), { signal, timeoutMs: config.llmCallTimeoutMs ?? 0 });
      state.consecutiveParseFailures = 0;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/^Budget exceeded:/i.test(msg)) {
        await finish(false, msg);
        return;
      }
      const classified = classifyError(e, state.consecutiveFailures);
      const willExceed = (state.consecutiveFailures + 1) >= config.maxFailures;
      onEvent({
        type: "error",
        step: state.step,
        message: friendlyErrorMessage(classified),
        recoverable: !classified.fatal && !willExceed,
      });
      if (dispatcher) {
        await safeDispatch("error", () => dispatcher!.error(makeCtx(state), friendlyErrorMessage(classified), !classified.fatal && !willExceed));
      }
      if (classified.fatal) {
        const doneText = `Fatal error (${classified.category}): ${classified.message}`;
        await finish(false, doneText);
        return;
      }
      if (classified.category === "cancelled") {
        onEvent({ type: "info", message: "Agent stopped by user." });
        const doneText = "Agent stopped by user.";
        await finish(false, doneText);
        return;
      }
      state.consecutiveFailures++;
      if (/\b(parse|unparseable)\b/i.test(msg)) {
        state.consecutiveParseFailures++;
      }
      if (state.consecutiveFailures >= config.maxFailures) {
        const doneText = `Agent aborted after ${config.maxFailures} consecutive failures. Last error: ${classified.message}`;
        await finish(false, doneText);
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
          await finish(false, doneText);
          return;
        }
      }
      state.step++;
      continue;
    }

    if (costCapExceeded(state)) {
      await finish(false, `Cost cap of $${config.costCapUsd} reached.`);
      return;
    }

    onEvent({
      type: "thinking", step: state.step, text: output.thinking,
      evaluation: output.evaluation_previous_goal, memory: output.memory, nextGoal: output.next_goal,
    });
    if (dispatcher) {
      await safeDispatch("thinking", () => dispatcher!.thinking(
        makeCtx(state), output.thinking, output.evaluation_previous_goal, output.memory, output.next_goal
      ));
    }

 // Preserve a sole `done` action even when the navigator emitted more
 // actions than maxActionsPerStep. The `done` action always means "stop and
 // finalize", so if it
 // is present we run ONLY it and discard the rest rather than truncating `done`
 // off the end of the queue.
    const soleDoneAction = output.action.find((a) => a.type === "done");
    const actions = soleDoneAction ? [soleDoneAction] : output.action.slice(0, config.maxActionsPerStep);
    if (output.action.length > config.maxActionsPerStep) {
 // Check `soleDoneAction` BEFORE warning: when a `done` is present we keep
 // ONLY it (we do NOT truncate), so the "truncating" wording would be
 // misleading. Specialize the message to reflect what actually happens.
      const truncMsg = soleDoneAction
        ? `Navigator emitted ${output.action.length} actions (max ${config.maxActionsPerStep}); keeping only the done action.`
        : `Navigator emitted ${output.action.length} actions (max ${config.maxActionsPerStep}); truncating.`;
      onEvent({ type: "error", step: state.step, message: truncMsg, recoverable: true });
      await safeDispatch("error", () => dispatcher!.error(makeCtx(state), truncMsg, true));
    }

    const doneAction = actions.find((a) => a.type === "done");

    if (doneAction && doneAction.type === "done") {
 // A step that pairs `done` with a sibling action is rejected at parse
 // time (AgentOutputSchema.action superRefine) before it reaches the
 // orchestrator, so `doneAction` is ALWAYS the sole action in the step.
      const result = await handleNavigatorDone(state, doneAction, output, browserState, tabs);
      if (result.finalized) {
 // `handleNavigatorDone` already emitted the terminal `done` event (via
 // `maybeJudgeAndFinalize` / `callPlannerAndHandleError`; the cost-cap path in
 // `handlePlannerDecision` emits it too) and recorded the real outcome in
 // `state.finalResult`. Emitting another `done` here would duplicate the
 // terminal event and let the last one clobber the genuine result, so fire
 // only the `runEnd` callback.
        await safeDispatch("runEnd", () =>
          dispatcher!.runEnd(buildRunResult(state, state.finalResult?.success ?? false, state.finalResult?.text ?? "")),
        );
        return;
      }
 // Fire stepEnd for the done step so metrics are accurate.
      await safeDispatch("stepEnd", () => dispatcher!.stepEnd(makeCtx(state), [{ action: doneAction, success: doneAction.success ?? true, message: `Navigator requested completion: ${doneAction.text}`, isDone: true }]));
 // Advance the budget counters so the `maxSteps` cap (while condition at
 // line 305) is eventually reached even when the planner persistently
 // refuses to finalize a navigator `done`. Without this, `state.step` froze
 // and the loop could run unbounded if the cost cap was also disabled.
      state.step++;
      state.navigatorStepsSincePlanner++;
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
              await safeDispatch("loopWarning", () => dispatcher!.loopWarning(makeCtx(state), warnCount));
 // Hard-stop once the action-repetition count reaches the top threshold. The
 // detector only warns below this; sustained repetition would otherwise burn
 // the full maxSteps budget before the hard cap ends the run.
              if (config.enableEarlyStop && warnCount >= LOOP_TOP_THRESHOLD) {
                await finish(false, `Loop detected: equivalent action repeated ${warnCount} times without progress — aborting run.`);
                return;
              }
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
        await safeDispatch("error", () => dispatcher!.error(makeCtx(state), errMsg, true));
        state.consecutiveFailures++;
        if (state.consecutiveFailures >= config.maxFailures) {
          const doneText = `Agent aborted after ${config.maxFailures} consecutive failures (executeActions).`;
          await finish(false, doneText);
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
        await safeDispatch("error", () => dispatcher!.error(makeCtx(state), errMsg, true));
        state.consecutiveFailures++;
        if (state.consecutiveFailures >= config.maxFailures) {
          const doneText = `Agent aborted after ${config.maxFailures} consecutive failures (executeActionQueue).`;
          await finish(false, doneText);
          return;
        }
        state.step++;
        continue;
      }
    }

    await safeDispatch("stepEnd", () => dispatcher!.stepEnd(makeCtx(state), results));

 // loopWarningCount is emitted as a "loop-warning" event by
 // executeActionQueue; the next step's injected nudges (built from
 // buildPreObserveNudges / buildPostObserveNudges in
 // context/injection-points.ts) already inject the loop-detection nudge via
 // injectLoopDetectionNudge. Setting pendingLoopWarning here would duplicate
 // the warning.

 // Takeover pause
    const takeoverResult = results.find((r) => r.action.type === "takeover");
    if (takeoverResult) {
      const takeoverAction = takeoverResult.action as { type: "takeover"; reason: string };
      const resumeResult = await waitForTakeoverResume(deps, takeoverAction.reason, state.step);
      if (resumeResult === "timeout") {
        const doneText = "Timed out waiting for user takeover.";
        await finish(false, doneText);
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
        await finish(false, doneText);
        return;
      }
    }

 // Settle & advance
    try {
      const jittered = settleDelay * (0.8 + Math.random() * 0.4);
      await withHeartbeat(
        state.step,
        onEvent,
        async (signal?: AbortSignal) => {
          if (deps.waitForSettled) {
            // `waitForSettled` has no signal param; withHeartbeat's abort
            // race still interrupts the settle on user Stop / SLA timeout.
            await deps.waitForSettled();
          } else {
            await sleep(jittered, signal);
          }
        },
        { signal: deps.signal, timeoutMs: SETTLE_SLA_MS },
      );
    } catch (e) {
      const errMsg = `waitForSettled failed: ${e instanceof Error ? e.message : String(e)}`;
      onEvent({ type: "error", step: state.step, message: errMsg, recoverable: true });
      await safeDispatch("error", () => dispatcher!.error(makeCtx(state), errMsg, true));
    }
    state.step++;
    state.navigatorStepsSincePlanner++;

 // Compaction check — measure the ACTUAL rendered-history size rather than
 // estimating `length * 500`. The estimate systematically undershoots once
 // `extract`/evaluation/memory/goal/action results accumulate, so compaction
 // fired far later than `compactionCharThreshold` intended and the history
 // could briefly exceed the model's context window before it kicked in.
 // Rendering is O(N) per step (no worse than the old estimate) and gives
 // `shouldCompact` the real character count it documents it expects.
    if (config.enableCompaction) {
      const stepGap = state.step - (state.lastCompactionStep ?? 0);
      // Skip the O(N) full-history render on the majority of steps: both
      // compaction gates require a minimum step gap (shouldCompact → interval,
      // approachingContextLimit → 3), so a render is pointless until stepGap
      // reaches min(interval, 3). The decision is unchanged because both gates
      // fail below that gap (historyLen defaults to 0 → below every threshold).
      const compactionGateReady = stepGap >= Math.min(config.compactionStepInterval, 3);
      let historyLen = 0;
      let approachingContextLimit = false;
      if (compactionGateReady) {
        historyLen = renderHistoryForSummarization(state.navigatorHistory).length;
        const contextBudgetChars = CONTEXT_SOFT_CAP_CHARS;
        approachingContextLimit = historyLen > contextBudgetChars && stepGap >= 3;
      }
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
        let compacted: Awaited<ReturnType<typeof runCompaction>> | null = null;
        try {
          compacted = await withHeartbeat(state.step, onEvent, (signal) => runCompaction(
            deps,
            state.navigatorHistory,
            state.step,
            (usd, tokensIn, tokensOut) => {
              addCost(state, usd);
              addTokens(state, tokensIn, tokensOut);
            },
            dispatcher,
            makeCtx(state),
            state.compactedMemory,
            signal,
          ), { signal, timeoutMs: config.llmCallTimeoutMs ?? 0 });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/^Budget exceeded:/i.test(msg)) {
            await finish(false, msg);
            return;
          }
 // `runCompaction` only re-throws Budget-exceeded errors; any other
 // error is caught internally and returns `null`. Re-throwing here
 // would erroneously kill the whole run if `runCompaction` ever
 // changed to re-throw transient errors, so we log-and-continue
 // (deferring compaction to a later step).
 //
 // Back off: record this step as the last compaction attempt so the
 // per-step retry doesn't fire compaction on EVERY subsequent step
 // (which would amplify cost/error rate while the failure persists).
 // The next attempt waits `compactionStepInterval` steps as normal.
          state.lastCompactionStep = state.step;
          onEvent({ type: "info", message: `Compaction skipped due to error: ${msg}` });
        }
        if (compacted) {
          state.navigatorHistory.length = 0;
          state.navigatorHistory.push(...compacted.keptRecent);
          state.compactedMemory = compacted.compactedMemory;
          state.lastCompactionStep = state.step;
          onEvent({ type: "compaction", step: state.step, compactedCount: compacted.compactedCount });
          await safeDispatch("compaction", () => dispatcher!.compaction(makeCtx(state), compacted.compactedCount));
        }
      }
    }

 // Periodic planner check
    if (state.navigatorStepsSincePlanner >= config.plannerInterval) {
      const result = await runPeriodicPlannerCheck(state, browserState);
      if (result.finalized) {
 // Same as the navigator-`done` finalize path: the terminal `done` was already
 // emitted by the helpers, so fire only `runEnd` here to avoid a duplicate.
        await safeDispatch("runEnd", () =>
          dispatcher!.runEnd(buildRunResult(state, state.finalResult?.success ?? false, state.finalResult?.text ?? "")),
        );
        return;
      }
    }
  }

  const doneText = `Reached max steps (${config.maxSteps}) without the planner calling done.`;
  await finish(false, doneText);
}
