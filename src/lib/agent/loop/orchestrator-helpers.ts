import type {
  AgentAction,
  AgentConfig,
  AgentOutput,
  AgentStepRequest,
  ActionResult,
  BrowserState,
  LogEvent,
  PlannerOutput,
  TabInfo,
} from "../types";
import { DEFAULT_CONFIG } from "../types";
import { classifyError, friendlyErrorMessage } from "../errors";
import { LoopDetector, LOOP_TOP_THRESHOLD } from "./loop-detector";
import { earlyStop, DEFAULT_EARLY_STOP_THRESHOLDS } from "./early-stop";
import { shouldCompact, renderHistoryForSummarization } from "./compaction";
import { CallbackDispatcher } from "../callbacks";
import type { LoopDeps, LoopState } from "./types";
import { BUDGET_WARNING_FRACTION } from "./constants";
import { buildPreObserveNudges, appendPendingLoopWarning } from "./context/injection-points";
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
import {
  clampPlanItem,
} from "./phases/planner-phases-utils";

// ─── Constants ─────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 20_000;
const CONTEXT_SOFT_CAP_CHARS = 400_000;
const SETTLE_SLA_MS = 30_000;

// ─── Control-flow result types ─────────────────────────────────────────────

type StepResult =
  | { kind: "continue" }
  | { kind: "exit"; success: boolean; text: string };

/** Payload carried between navigator-step phases. */
type ObservePayload = { browserState: BrowserState; tabs: TabInfo[] };
type ModelCallPayload = { output: AgentOutput };
type ActionSelectionPayload = {
  actions: AgentAction[];
  doneAction: Extract<AgentAction, { type: "done" }> | undefined;
};
type ExecutionPayload = { results: ActionResult[] };

/** Outcome of a navigator-step phase: abort with a terminal StepResult, or
 * continue with the phase's data payload. */
type NavigatorPhaseResult<T> =
  | { kind: "abort"; result: StepResult }
  | { kind: "ok"; data: T };

/** Outcome of a navigator-step phase that produces no payload. */
type NavigatorPhaseOutcome =
  | { kind: "abort"; result: StepResult }
  | { kind: "ok" };

// ─── Sleep + heartbeat ─────────────────────────────────────────────────────

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
 * Wrap a long-running await (LLM call, compaction, action settle) so a
 * `heartbeat` event is emitted on a fixed interval while it is in flight.
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

  const controller = new AbortController();
  let timedOut = false;

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

// ─── Dispatch + finish helpers ─────────────────────────────────────────────

/**
 * Safely invoke a user-supplied dispatcher/callback handler. A throwing handler
 * must NOT abort the whole agent loop.
 */
export async function safeDispatch(
  state: LoopState,
  label: string,
  fn: () => Promise<void>,
): Promise<void> {
  if (!state.dispatcher) return;
  try {
    await fn();
  } catch (e) {
    console.error(`[orchestrator] dispatcher handler "${label}" threw (continuing run):`, e);
  }
}

/**
 * Like {@link safeDispatch} but narrows the dispatcher to non-null for the
 * handler. `safeDispatch` guards `if (!state.dispatcher) return;` before
 * invoking the handler, and `state.dispatcher` is assigned exactly once in
 * `initState` (never reassigned), so the non-null assertion here is sound.
 * This is the single consolidation point for the per-call-site
 * `state.dispatcher!` assertions.
 */
function dispatch(
  state: LoopState,
  label: string,
  fn: (dispatcher: CallbackDispatcher) => Promise<void>,
): Promise<void> {
  return safeDispatch(state, label, () => fn(state.dispatcher!));
}

/**
 * Emit the terminal `done` event + `runEnd` dispatcher callback in one place.
 *
 * Idempotent: multiple call sites can fire within a single run (e.g. a
 * cost-capped compaction calls `finish()` and the step continues), so the
 * terminal event is emitted at most once. The FIRST caller wins; its text is
 * recorded in `state.finalResult` (if not already set) so the `done` event
 * and the `runEnd` dispatch always agree.
 */
export async function finish(
  state: LoopState,
  success: boolean,
  text: string,
): Promise<void> {
  if (state.terminalEmitted) return;
  state.terminalEmitted = true;
  if (!state.finalResult) state.finalResult = { success, text };
  state.onEvent({ type: "done", step: state.step, success, text });
  await dispatch(state, "runEnd", (d) =>
    d.runEnd(buildRunResult(state, success, text)),
  );
}

/**
 * Emit the terminal `runEnd` dispatcher callback and return the matching
 * "exit" StepResult. Used whenever the run ends through a `finalized` path
 * (the `done` event was already emitted inline by the finalizing helper).
 * Guarded by the same `terminalEmitted` flag as `finish` so a finalization
 * after a prior terminal emission can't dispatch `runEnd` twice.
 */
async function finishWithRunEnd(state: LoopState): Promise<StepResult> {
  if (!state.terminalEmitted) {
    state.terminalEmitted = true;
    await dispatch(state, "runEnd", (d) =>
      d.runEnd(buildRunResult(state, state.finalResult?.success ?? false, state.finalResult?.text ?? "")),
    );
  }
  return { kind: "exit", success: state.finalResult?.success ?? false, text: state.finalResult?.text ?? "" };
}

// ─── Navigator-step exit helpers ───────────────────────────────────────────

/**
 * Emit the canonical "Agent stopped by user." terminal sequence: info event,
 * then `finish`, then the matching exit StepResult. Every user-stop path in
 * the navigator step shares these exact three statements.
 */
async function exitStoppedByUser(state: LoopState): Promise<StepResult> {
  state.onEvent({ type: "info", message: "Agent stopped by user." });
  await finish(state, false, "Agent stopped by user.");
  return { kind: "exit", success: false, text: "Agent stopped by user." };
}

/**
 * Emit the cost-cap terminal sequence: `finish` with the canonical cost-cap
 * text, then the matching exit StepResult.
 */
async function exitCostCap(state: LoopState, config: AgentConfig): Promise<StepResult> {
  const text = `Cost cap of $${config.costCapUsd} reached.`;
  await finish(state, false, text);
  return { kind: "exit", success: false, text };
}

/**
 * Emit the terminal sequence for an arbitrary failure text. Every non-stop
 * exit in the navigator step is exactly `finish(state, false, text)` followed
 * by `{ kind: "exit", success: false, text }`; the per-site differences
 * (extra events emitted before the exit) stay at the call site, so this
 * helper is safe to share across all of them.
 */
async function exitWithFinish(state: LoopState, text: string): Promise<StepResult> {
  await finish(state, false, text);
  return { kind: "exit", success: false, text };
}

// ─── Config validation ─────────────────────────────────────────────────────

export async function validateAndBuildConfig(
  deps: LoopDeps,
): Promise<import("../types").AgentConfig> {
  let config: import("../types").AgentConfig;
  try {
    const { validateConfig } = await import("../config");
    const validatedConfig = validateConfig({ ...DEFAULT_CONFIG, ...deps.config });
    config = { ...validatedConfig, enableJudge: validatedConfig.enableJudge ?? DEFAULT_CONFIG.enableJudge };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[orchestrator] config validation failed:", msg);
    if (e instanceof Error && (e as { issues?: unknown }).issues) {
      throw e;
    }
    throw new Error(`Invalid agent configuration: ${msg}`);
  }
  return config;
}

// ─── State initialization ──────────────────────────────────────────────────

export function initState(
  deps: LoopDeps,
  config: import("../types").AgentConfig,
): LoopState {
  const settleDelay = deps.settleDelay ?? 500;

  let dispatcher: CallbackDispatcher | undefined;
  if (deps.callbacks && deps.callbacks.length > 0) {
    dispatcher = new CallbackDispatcher();
    for (const h of deps.callbacks) dispatcher.register(h);
  }

  return {
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
}

// ─── Initial planner phase ─────────────────────────────────────────────────

/**
 * Run the initial planner call and handle web_task / done decisions.
 * Returns "exit" when the run should terminate, "continue" otherwise.
 */
export async function runInitialPlannerPhase(
  state: LoopState,
): Promise<StepResult> {
  const { deps, config } = state;
  const { task, onEvent, signal } = state;

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
      state.dispatcher,
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
    await finish(state, false, doneText);
    return { kind: "exit", success: false, text: doneText };
  }

  if (costCapExceeded(state)) {
    const text = `Cost cap of $${config.costCapUsd} reached.`;
    await finish(state, false, text);
    return { kind: "exit", success: false, text };
  }

  if (plannerResult.decision === "web_task") {
    const text = plannerResult.text || "";
    const finalized = await maybeJudgeAndFinalize(
      deps,
      config,
      {
        step: 0,
        success: true,
        text,
        navigatorHistory: state.navigatorHistory,
        onCost: (usd, tokensIn, tokensOut) => {
          addCost(state, usd);
          addTokens(state, tokensIn, tokensOut);
        },
      },
      state,
      state.dispatcher,
      makeCtx(state)
    );
    if (finalized) {
      return finishWithRunEnd(state);
    }
    onEvent({
      type: "info",
      message: "Judge disagreed with web_task result — continuing the run.",
    });
    plannerResult = { ...plannerResult, decision: "continue" };
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
      state.dispatcher,
      makeCtx(state)
    );
    if (finalized) {
      return finishWithRunEnd(state);
    }
  // The judge refused to certify the self-reported `done` — mirror the
  // web_task branch: announce it and rewrite the decision to "continue" so
  // the plan application below cannot silently reapply a stale done state.
    onEvent({
      type: "info",
      message: "Judge disagreed with done result — continuing the run.",
    });
    plannerResult = { ...plannerResult, decision: "continue" };
  }

  state.plan = plannerResult.plan;
  // Clamp `current_plan_item` against the plan in effect (shared with the
  // periodic-planner path via clampPlanItem): coerces out-of-range and
  // non-integer values to a valid index and surfaces the coercion as an
  // info event.
  const clampedCpi = clampPlanItem(plannerResult.plan, plannerResult.current_plan_item, onEvent);
  state.currentPlanItem = clampedCpi ?? 0;
  state.currentGoal = plannerResult.next_goal || (state.plan && state.plan[state.currentPlanItem]) || task;
  onEvent({
    type: "planner-step", step: state.step, decision: plannerResult.decision,
    goal: state.currentGoal, plan: state.plan,
  });
  if (state.dispatcher) {
    await dispatch(state, "plannerStep", (d) => d.plannerStep(makeCtx(state), plannerResult.decision, state.currentGoal, state.plan));
  }

  return { kind: "continue" };
}

// ─── Compaction check ──────────────────────────────────────────────────────

/**
 * Check compaction conditions and run compaction if needed.
 * Mutates `state.navigatorHistory`, `state.compactedMemory`, and
 * `state.lastCompactionStep`.
 */
async function checkAndRunCompaction(
  state: LoopState,
): Promise<void> {
  const { deps, config } = state;
  if (!config.enableCompaction) return;

  const stepGap = state.step - (state.lastCompactionStep ?? 0);
  const compactionGateReady = stepGap >= Math.min(config.compactionStepInterval, 3);
  let historyLen = 0;
  let approachingContextLimit = false;
  if (compactionGateReady) {
    historyLen = renderHistoryForSummarization(state.navigatorHistory).length;
    approachingContextLimit = historyLen > CONTEXT_SOFT_CAP_CHARS && stepGap >= 3;
  }
  if (approachingContextLimit) {
    state.onEvent({
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
      compacted = await withHeartbeat(state.step, state.onEvent, (signal) => runCompaction(
        deps,
        state.navigatorHistory,
        state.step,
        (usd, tokensIn, tokensOut) => {
          addCost(state, usd);
          addTokens(state, tokensIn, tokensOut);
        },
        state.dispatcher,
        makeCtx(state),
        state.compactedMemory,
        signal,
      ), { signal: deps.signal, timeoutMs: config.llmCallTimeoutMs ?? 0 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/^Budget exceeded:/i.test(msg)) {
        await finish(state, false, msg);
        return;
      }
      state.lastCompactionStep = state.step;
      state.onEvent({ type: "info", message: `Compaction skipped due to error: ${msg}` });
    }
    if (compacted) {
      state.navigatorHistory.length = 0;
      state.navigatorHistory.push(...compacted.keptRecent);
      state.compactedMemory = compacted.compactedMemory;
      state.lastCompactionStep = state.step;
      state.onEvent({ type: "compaction", step: state.step, compactedCount: compacted.compactedCount });
      await dispatch(state, "compaction", (d) => d.compaction(makeCtx(state), compacted!.compactedCount));
    }
  }
}

// ─── Navigator step (single while-loop iteration) ─────────────────────────

/**
 * Run a single navigator step: observe → challenge → LLM call → execute →
 * settle. Returns "exit" when the run should terminate, "continue" otherwise.
 *
 * The step is decomposed into named phase functions (preflight, start,
 * observe, challenge, model call, action selection, done handling, execution,
 * step end, history update, settle, tail) so each phase has a single,
 * testable responsibility. The phases run strictly in sequence; any phase
 * that returns an `abort` outcome terminates the step immediately with that
 * StepResult, exactly like the original single-function control flow.
 */
export async function runNavigatorStep(state: LoopState): Promise<StepResult> {
  // Pre-flight: user stop / cost cap / budget warning.
  const preflight = await runNavigatorPreflight(state);
  if (preflight) return preflight;

  // Pre-observe nudges + step-start event + dispatch.
  await runNavigatorStart(state);

  // Observe the page, record the state event + loop fingerprint, dispatch the
  // screenshot callback.
  const observed = await runNavigatorObserve(state);
  if (observed.kind === "abort") return observed.result;
  let { browserState, tabs } = observed.data;

  // Anti-bot challenge detection; re-observes when a challenge clears.
  const challenge = await runNavigatorChallenge(state, browserState, tabs);
  if (challenge.kind === "abort") return challenge.result;
  ({ browserState, tabs } = challenge.data);

  // Post-observe nudges + pause check + navigator request build.
  appendPostObserveNudges(state, browserState);
  await runPauseCheck(state);
  const navRequest = await prepareNavigatorRequest(state, browserState);

  // Navigator LLM call (heartbeat + SLA wrapped), with error classification.
  const call = await runNavigatorModelCall(state, navRequest);
  if (call.kind === "abort") return call.result;
  const { output } = call.data;

  // Cost-cap re-check + thinking event + action selection/truncation.
  const selection = await runNavigatorActionSelection(state, output);
  if (selection.kind === "abort") return selection.result;
  const { actions, doneAction } = selection.data;

  // Navigator `done` → planner verify/judge path (always terminal).
  if (doneAction) {
    return runNavigatorDoneAction(state, doneAction, output, browserState, tabs);
  }

  // Execute the action batch (executeActions override or built-in queue).
  const execution = await runNavigatorActionExecution(state, actions, browserState);
  if (execution.kind === "abort") return execution.result;
  const { results } = execution.data;

  // Step-end dispatch + takeover resume wait.
  const stepEnd = await runNavigatorStepEnd(state, results);
  if (stepEnd.kind === "abort") return stepEnd.result;

  // History push + failure accounting + early-stop.
  const historyUpdate = await runNavigatorHistoryUpdate(state, output, results);
  if (historyUpdate.kind === "abort") return historyUpdate.result;

  // Settle wait (page-stable before the next step).
  const settle = await runNavigatorSettle(state);
  if (settle.kind === "abort") return settle.result;

  // Step rollover + compaction + post-compaction checks + periodic planner.
  return runNavigatorTail(state, browserState);
}

/**
 * Phase: pre-flight. User-stop and cost-cap checks short-circuit the step
 * with the canonical terminal results; the budget-warning event fires once at
 * the warning step. Returns null when the step should proceed.
 */
async function runNavigatorPreflight(state: LoopState): Promise<StepResult | null> {
  const { config } = state;
  const { onEvent, signal } = state;

  if (signal?.aborted) {
    return exitStoppedByUser(state);
  }
  if (costCapExceeded(state)) {
    return exitCostCap(state, config);
  }
  if (state.step === Math.max(1, Math.floor(config.maxSteps * BUDGET_WARNING_FRACTION))) {
    onEvent({ type: "budget-warning", step: state.step, pct: Math.floor(BUDGET_WARNING_FRACTION * 100) });
  }
  return null;
}

/**
 * Phase: step start. Applies the pre-observe nudges, emits the
 * `navigator-step-start` event, and dispatches the `stepStart` callback.
 */
async function runNavigatorStart(state: LoopState): Promise<void> {
  const preObserveNudges = buildPreObserveNudges(state);
  if (preObserveNudges) {
    appendPendingLoopWarning(state, preObserveNudges);
  }

  state.onEvent({ type: "navigator-step-start", step: state.step });
  await dispatch(state, "stepStart", (d) => d.stepStart(makeCtx(state)));
}

/**
 * Phase: observe. Wraps `observeState` with the error/failure accounting and
 * the page-fingerprint (stagnation) loop detection. On success returns the
 * observed `browserState` + tabs and dispatches the screenshot callback.
 */
async function runNavigatorObserve(
  state: LoopState,
): Promise<NavigatorPhaseResult<ObservePayload>> {
  const { config } = state;
  const { onEvent } = state;

  const observed = await observeState(state);
  if (observed.status === "error") {
    onEvent({
      type: "error", step: state.step,
      message: observed.message,
      recoverable: true,
    });
    await dispatch(state, "error", (d) => d.error(makeCtx(state), observed.message, true));
    state.consecutiveFailures++;
    if (state.consecutiveFailures >= config.maxFailures) {
      const text = `Agent aborted after ${config.maxFailures} consecutive failures (${observed.phase}).`;
      return { kind: "abort", result: await exitWithFinish(state, text) };
    }
    state.step++;
    return { kind: "abort", result: { kind: "continue" } };
  }
  const { state: browserState, tabs } = observed;
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
        appendPendingLoopWarning(state, LoopDetector.stagnantWarningText(stagnantCount));
        onEvent({ type: "loop-warning", step: state.step, count: stagnantCount });
        if (config.enableEarlyStop && stagnantCount >= LOOP_TOP_THRESHOLD) {
          const text = `Loop detected: page state unchanged across ${stagnantCount} snapshots — aborting run.`;
          return { kind: "abort", result: await exitWithFinish(state, text) };
        }
      }
    } catch (e) {
      console.warn(
        "[orchestrator] recordPageState failed (stagnation detection may be inactive):",
        e,
      );
    }
  }
  if (browserState.screenshot && state.dispatcher) {
    const screenshot = browserState.screenshot;
    await dispatch(state, "screenshot", (d) => d.screenshot(makeCtx(state), screenshot));
  }

  return { kind: "ok", data: { browserState, tabs } };
}

/**
 * Phase: challenge. Runs the anti-bot challenge detector; when a challenge is
 * detected it waits for resolution (or a takeover), then re-observes the page
 * and returns the refreshed state.
 */
async function runNavigatorChallenge(
  state: LoopState,
  browserState: BrowserState,
  tabs: TabInfo[],
): Promise<NavigatorPhaseResult<ObservePayload>> {
  const { deps } = state;
  const { onEvent } = state;

  const challengeResult = await runChallengeDetection(state);
  if (challengeResult.challenge) {
    if (challengeResult.timedOut) {
      const resumeResult = await waitForTakeoverResume(
        deps, `Anti-bot challenge (${challengeResult.challenge.kind}): ${challengeResult.challenge.message}`, state.step,
      );
      if (resumeResult === "timeout") {
        const text = `Timed out waiting for anti-bot challenge to resolve.`;
        return { kind: "abort", result: await exitWithFinish(state, text) };
      }
    }
    const reObserved = await observeState(state);
    if (reObserved.status === "error") {
      onEvent({
        type: "error", step: state.step,
        message: `Re-observe after challenge failed: ${reObserved.message}`,
        recoverable: true,
      });
      state.step++;
      return { kind: "abort", result: { kind: "continue" } };
    }
    Object.assign(browserState, reObserved.state);
    tabs = reObserved.tabs;
    onEvent({ type: "resumed", step: state.step });
    onEvent({ type: "info", message: `Anti-bot challenge cleared — resuming.` });
  }
  return { kind: "ok", data: { browserState, tabs } };
}

/**
 * Phase: navigator model call. Runs the navigator LLM call (heartbeat + SLA
 * wrapped, with cost accounting) and applies the error-classification
 * retry/failure ladder on throw. On success resets the parse-failure counter
 * and returns the parsed output.
 */
async function runNavigatorModelCall(
  state: LoopState,
  navRequest: AgentStepRequest,
): Promise<NavigatorPhaseResult<ModelCallPayload>> {
  const { deps, config } = state;
  const { onEvent, signal } = state;

  let output: AgentOutput;
  try {
    output = await withHeartbeat(state.step, onEvent, (signal) => callNavigatorWithRetry(
      deps, navRequest, state.step, (usd, tokensIn, tokensOut) => {
        addCost(state, usd);
        addTokens(state, tokensIn, tokensOut);
      },
      state.dispatcher, makeCtx(state), signal, state.config.costCapUsd, () => costCapExceeded(state)
    ), { signal, timeoutMs: config.llmCallTimeoutMs ?? 0 });
    state.consecutiveParseFailures = 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/^Budget exceeded:/i.test(msg)) {
      return { kind: "abort", result: await exitWithFinish(state, msg) };
    }
    const classified = classifyError(e, state.consecutiveFailures);
    const willExceed = (state.consecutiveFailures + 1) >= config.maxFailures;
    onEvent({
      type: "error",
      step: state.step,
      message: friendlyErrorMessage(classified),
      recoverable: !classified.fatal && !willExceed,
      code: classified.machineCode,
      recovery: classified.recoveryHint,
    });
    if (state.dispatcher) {
      await dispatch(state, "error", (d) => d.error(makeCtx(state), friendlyErrorMessage(classified), !classified.fatal && !willExceed));
    }
    if (classified.fatal) {
      const text = `Fatal error (${classified.category}): ${classified.message}`;
      return { kind: "abort", result: await exitWithFinish(state, text) };
    }
    if (classified.category === "cancelled") {
      return { kind: "abort", result: await exitStoppedByUser(state) };
    }
    state.consecutiveFailures++;
    if (/\b(parse|unparseable)\b/i.test(msg)) {
      state.consecutiveParseFailures++;
    }
    if (state.consecutiveFailures >= config.maxFailures) {
      const text = `Agent aborted after ${config.maxFailures} consecutive failures. Last error: ${classified.message}`;
      return { kind: "abort", result: await exitWithFinish(state, text) };
    }
    if (config.enableEarlyStop) {
      const es = earlyStop(
        state.navigatorHistory,
        state.consecutiveParseFailures,
        config.earlyStopThresholds ?? DEFAULT_EARLY_STOP_THRESHOLDS,
      );
      if (es.stop) {
        const text = `Early-stop: ${es.reason}`;
        return { kind: "abort", result: await exitWithFinish(state, text) };
      }
    }
    state.step++;
    return { kind: "abort", result: { kind: "continue" } };
  }
  return { kind: "ok", data: { output } };
}

/**
 * Phase: action selection. Re-checks the cost cap, emits the `thinking` event
 * (+ dispatch), and selects/truncates the action batch (`done` is kept alone).
 */
async function runNavigatorActionSelection(
  state: LoopState,
  output: AgentOutput,
): Promise<NavigatorPhaseResult<ActionSelectionPayload>> {
  const { config } = state;
  const { onEvent } = state;

  if (costCapExceeded(state)) {
    return { kind: "abort", result: await exitCostCap(state, config) };
  }

  onEvent({
    type: "thinking", step: state.step, text: output.thinking,
    evaluation: output.evaluation_previous_goal, memory: output.memory, nextGoal: output.next_goal,
  });
  if (state.dispatcher) {
    await dispatch(state, "thinking", (d) => d.thinking(
      makeCtx(state), output.thinking, output.evaluation_previous_goal, output.memory, output.next_goal
    ));
  }

  const soleDoneAction = output.action.find((a) => a.type === "done");
  const actions = soleDoneAction ? [soleDoneAction] : output.action.slice(0, config.maxActionsPerStep);
  if (output.action.length > config.maxActionsPerStep) {
    const truncMsg = soleDoneAction
      ? `Navigator emitted ${output.action.length} actions (max ${config.maxActionsPerStep}); keeping only the done action.`
      : `Navigator emitted ${output.action.length} actions (max ${config.maxActionsPerStep}); truncating.`;
    onEvent({ type: "error", step: state.step, message: truncMsg, recoverable: true });
    await dispatch(state, "error", (d) => d.error(makeCtx(state), truncMsg, true));
  }

  const doneAction = actions.find((a) => a.type === "done");
  return { kind: "ok", data: { actions, doneAction } };
}

/**
 * Phase: navigator `done`. Asks the planner to verify the self-reported
 * completion (with the judge path); on finalization ends the run, otherwise
 * dispatches `stepEnd` with the done action and continues the loop.
 * Always returns a terminal StepResult.
 */
async function runNavigatorDoneAction(
  state: LoopState,
  doneAction: Extract<AgentAction, { type: "done" }>,
  output: AgentOutput,
  browserState: BrowserState,
  tabs: TabInfo[],
): Promise<StepResult> {
  const { deps } = state;

  let result: Awaited<ReturnType<typeof handleNavigatorDone>>;
  try {
    result = await handleNavigatorDone(state, doneAction, output, browserState, tabs);
  } catch (e) {
    // The planner-phase settle wait re-throws aborts: a user stop during
    // the verification settle must end the run with the canonical stop
    // text, exactly like the navigator-path settle wait below.
    const isAbort = deps.signal?.aborted ||
      (e instanceof Error && (/abort/i.test(e.name) || /abort/i.test(e.message)));
    if (isAbort) {
      return exitStoppedByUser(state);
    }
    throw e;
  }
  if (result.finalized) {
    return finishWithRunEnd(state);
  }
  await dispatch(state, "stepEnd", (d) => d.stepEnd(makeCtx(state), [{ action: doneAction, success: doneAction.success ?? false, message: `Navigator requested completion: ${doneAction.text}`, isDone: true }]));
  state.step++;
  state.navigatorStepsSincePlanner++;
  return { kind: "continue" };
}

/**
 * Phase: action execution. Runs the action batch through `deps.executeActions`
 * (with per-action loop-detector recording) or the built-in queue, with the
 * failure/budget/cost-cap accounting for both branches.
 */
async function runNavigatorActionExecution(
  state: LoopState,
  actions: AgentAction[],
  browserState: BrowserState,
): Promise<NavigatorPhaseResult<ExecutionPayload>> {
  const { deps, config } = state;
  const { onEvent } = state;

  const agentMode = deps.mode ?? "standard";
  let results: ActionResult[];
  if (deps.executeActions) {
    try {
      if (config.enableLoopDetection) {
        for (const action of actions) {
          state.loopDetector.record(action);
          const warnCount = state.loopDetector.shouldWarn();
          if (warnCount > 0) {
            onEvent({ type: "loop-warning", step: state.step, count: warnCount });
            await dispatch(state, "loopWarning", (d) => d.loopWarning(makeCtx(state), warnCount));
            if (config.enableEarlyStop && warnCount >= LOOP_TOP_THRESHOLD) {
              const text = `Loop detected: equivalent action repeated ${warnCount} times without progress — aborting run.`;
              return { kind: "abort", result: await exitWithFinish(state, text) };
            }
          }
        }
      }
      results = await deps.executeActions(actions, browserState);
      if (costCapExceeded(state)) {
        onEvent({ type: "info", message: "Cost cap exceeded mid-step. Stopping." });
        return { kind: "abort", result: await exitCostCap(state, config) };
      }
      if (config.enableLoopDetection && results.some((r) => r.pageChanged)) {
        state.loopDetector.reset();
      }
    } catch (e) {
      const errMsg = `executeActions override failed: ${e instanceof Error ? e.message : String(e)}`;
      onEvent({ type: "error", step: state.step, message: errMsg, recoverable: true });
      await dispatch(state, "error", (d) => d.error(makeCtx(state), errMsg, true));
      state.consecutiveFailures++;
      if (state.consecutiveFailures >= config.maxFailures) {
        const text = `Agent aborted after ${config.maxFailures} consecutive failures (executeActions).`;
        return { kind: "abort", result: await exitWithFinish(state, text) };
      }
      state.step++;
      return { kind: "abort", result: { kind: "continue" } };
    }
  } else {
    try {
      const queueResult = await executeActionQueue(
        deps, actions, browserState, state.step, agentMode,
        state.loopDetector, config, state.dispatcher, makeCtx(state),
        () => costCapExceeded(state)
      );
      results = queueResult.results;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/^Budget exceeded:/i.test(msg)) {
        return { kind: "abort", result: await exitWithFinish(state, msg) };
      }
      const errMsg = `executeActionQueue failed: ${msg}`;
      onEvent({ type: "error", step: state.step, message: errMsg, recoverable: true });
      await dispatch(state, "error", (d) => d.error(makeCtx(state), errMsg, true));
      state.consecutiveFailures++;
      if (state.consecutiveFailures >= config.maxFailures) {
        const text = `Agent aborted after ${config.maxFailures} consecutive failures (executeActionQueue).`;
        return { kind: "abort", result: await exitWithFinish(state, text) };
      }
      state.step++;
      return { kind: "abort", result: { kind: "continue" } };
    }
  }
  return { kind: "ok", data: { results } };
}

/**
 * Phase: step end. Dispatches the `stepEnd` callback with the results and
 * waits for a user takeover resume when a takeover action was executed.
 */
async function runNavigatorStepEnd(
  state: LoopState,
  results: ActionResult[],
): Promise<NavigatorPhaseOutcome> {
  const { deps } = state;

  await dispatch(state, "stepEnd", (d) => d.stepEnd(makeCtx(state), results));

  const takeoverResult = results.find((r) => r.action.type === "takeover");
  if (takeoverResult) {
    const takeoverAction = takeoverResult.action as { type: "takeover"; reason: string };
    const resumeResult = await waitForTakeoverResume(deps, takeoverAction.reason, state.step);
    if (resumeResult === "timeout") {
      const text = "Timed out waiting for user takeover.";
      return { kind: "abort", result: await exitWithFinish(state, text) };
    }
  }
  return { kind: "ok" };
}

/**
 * Phase: history update. Pushes the step into the navigator history, updates
 * the consecutive-failure counter from the results, and applies the
 * early-stop detector.
 */
async function runNavigatorHistoryUpdate(
  state: LoopState,
  output: AgentOutput,
  results: ActionResult[],
): Promise<NavigatorPhaseOutcome> {
  const { config } = state;
  const { onEvent } = state;

  state.navigatorHistory.push({
    step: state.step, agent: "navigator",
    evaluation: output.evaluation_previous_goal,
    memory: output.memory, goal: output.next_goal, results,
  });

  const failureCount = results.filter((r) => !r.success).length;
  state.consecutiveFailures = failureCount > results.length / 2 ? state.consecutiveFailures + 1 : 0;

  if (config.enableEarlyStop) {
    const es = earlyStop(
      state.navigatorHistory,
      state.consecutiveParseFailures,
      config.earlyStopThresholds ?? DEFAULT_EARLY_STOP_THRESHOLDS,
    );
    if (es.stop) {
      const text = `Early-stop: ${es.reason}`;
      const isParseFailure = es.reason.includes("parse");
      const warnCount = isParseFailure
        ? state.consecutiveParseFailures
        : (config.earlyStopThresholds?.repeatingAction ?? 3);
      onEvent({ type: "loop-warning", step: state.step, count: warnCount });
      return { kind: "abort", result: await exitWithFinish(state, text) };
    }
  }
  return { kind: "ok" };
}

/**
 * Phase: settle. Waits for the page to settle (either `deps.waitForSettled`
 * or a jittered sleep, heartbeat + SLA wrapped); a user stop during the wait
 * exits with the canonical stop result instead of a recoverable error.
 */
async function runNavigatorSettle(state: LoopState): Promise<NavigatorPhaseOutcome> {
  const { deps } = state;
  const { onEvent } = state;

  try {
    const jittered = state.settleDelay * (0.8 + Math.random() * 0.4);
    await withHeartbeat(
      state.step,
      onEvent,
      async (signal?: AbortSignal) => {
        if (deps.waitForSettled) {
          await deps.waitForSettled();
        } else {
          await sleep(jittered, signal);
        }
      },
      { signal: deps.signal, timeoutMs: SETTLE_SLA_MS },
    );
  } catch (e) {
    // A user stop during the settle wait is not a settle failure: exit
    // immediately with the same "Agent stopped by user." result as every
    // other stop-path, instead of surfacing a recoverable error and letting
    // the run continue into the next step.
    const isAbort = deps.signal?.aborted || (e instanceof Error && (/abort/i.test(e.name) || /abort/i.test(e.message)));
    if (isAbort) {
      return { kind: "abort", result: await exitStoppedByUser(state) };
    }
    const errMsg = `waitForSettled failed: ${e instanceof Error ? e.message : String(e)}`;
    onEvent({ type: "error", step: state.step, message: errMsg, recoverable: true });
    await dispatch(state, "error", (d) => d.error(makeCtx(state), errMsg, true));
  }
  return { kind: "ok" };
}

/**
 * Phase: tail. Rolls the step counter forward, runs compaction, re-checks the
 * terminal/cost-cap/abort conditions after it, and runs the periodic planner
 * check when due. Always returns a terminal StepResult.
 */
async function runNavigatorTail(state: LoopState, browserState: BrowserState): Promise<StepResult> {
  const { config } = state;
  const { signal } = state;

  state.step++;
  state.navigatorStepsSincePlanner++;

  await checkAndRunCompaction(state);

  // Compaction can terminate the run itself: the summarizer call hit the
  // cost cap (checkAndRunCompaction finishes on "Budget exceeded"), or the
  // user stopped while it was in flight (withHeartbeat aborts it). Both
  // would otherwise fall through into the periodic planner check below and
  // fire another outbound LLM call after the run already ended.
  if (state.terminalEmitted || state.finalResult) {
    return finishWithRunEnd(state);
  }
  if (costCapExceeded(state)) {
    return exitCostCap(state, config);
  }
  if (signal?.aborted) {
    return exitStoppedByUser(state);
  }

  if (state.navigatorStepsSincePlanner >= config.plannerInterval) {
    const result = await runPeriodicPlannerCheck(state, browserState);
    if (result.finalized) {
      return finishWithRunEnd(state);
    }
  }

  return { kind: "continue" };
}
