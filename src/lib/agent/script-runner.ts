/**
 * Browser-agnostic YAML script engine — the port of stealthy-auto-browse's
 * `script_runner.py` (650 ln) as a pure engine behind the `executeAction`
 * boundary. A validated script is executed through an injected dispatch
 * function (the executor wires each step to `executeAction`), and the result
 * is the exact envelope `{name, success, steps_executed, steps_total,
 * duration, step_results, outputs}`.
 *
 * The engine is browser-independent: no DOM, no chrome.*, no os.environ.
 * `runScript` receives an optional `getEnv` accessor (the wiring layer points
 * it at the local settings store) used to substitute `${env.VAR}` placeholders
 * recursively before a step executes. The `%secret%` syntax handled by
 * secrets.ts is deliberately left untouched — env vars are NOT secrets.
 *
 * The `javascript` condition (and the generated element/text/url page
 * expressions) dispatch `{action: "eval", expression}` to the injected
 * dispatch function, which the wiring layer routes to the local evaluate
 * handler — the same fail-closed, sandboxed path used by the agent loop. A
 * failed or non-boolean evaluation surfaces as "condition evaluation failed",
 * so a blocked domain cannot silently pass a script condition.
 *
 * This module is the engine facade: the YAML/JSON parser lives in
 * `script-parser.ts` and the structural validation in `script-validation.ts`.
 * Both are re-exported here unchanged so `parseScriptYaml`, `validateScript`,
 * and `ScriptValidationError` keep their `script-runner` import surface
 * (used by the executor and the contract tests).
 */

import { validateScript, ScriptValidationError, CONTROL_TYPES, isRecord } from "./script-validation";

// ─── Limits (mirror upstream constants) ─────────────────────────────────────

const MAX_LOOP_STEP_EXECUTIONS = 1_000;
const CONDITION_POLL_INTERVAL_MS = 100;

/** `${env.VAR}` placeholder — distinct from the `%secret%` secret syntax. */
const ENV_RE = /\$\{env\.([^}]+)\}/g;

// ─── Facade re-exports (parser + validation split) ─────────────────────────

export { parseScriptYaml } from "./script-parser";
export { validateScript, ScriptValidationError };

// ─── Types ──────────────────────────────────────────────────────────────────

/** A single dispatched step result, as produced by the executor wiring. */
export interface ScriptDispatchResult {
  success: boolean;
  /** Structured payload (extract/find results, etc.). */
  data?: unknown;
  /** String payload (evaluate returns, element reads, etc.). */
  extractedContent?: string;
  /** Human-readable why (failure messages ride through to step_results). */
  message?: string;
  /** Raw binary payload (screenshots) — encoded as a data URI when captured. */
  _binary?: Uint8Array;
}

/** Dispatch one script step. Throwing is tolerated (reported as a failed step). */
export type ScriptDispatchFn = (step: Record<string, unknown>) => Promise<ScriptDispatchResult>;

/** Options for a single `runScript` invocation. */
export interface ScriptRunOptions {
  /** Resolve `${env.VAR}`. Missing keys resolve to "". Defaults to (() => ""). */
  getEnv?: (key: string) => string;
}

/** The exact result envelope produced by `runScript`. */
export interface ScriptRunEnvelope {
  name: string;
  success: boolean;
  steps_executed: number;
  steps_total: number;
  duration: number;
  step_results: Array<Record<string, unknown>>;
  /** Present ONLY when at least one step produced an output via `output_id`. */
  outputs?: Record<string, unknown>;
}

/** A page-state condition could not be evaluated (dispatch failed or non-bool). */
class ConditionEvaluationError extends Error {}

interface ExecutionState {
  outputs: Record<string, unknown>;
  loopStepExecutions: number;
}

interface ExecuteStepsResult {
  stepResults: Array<Record<string, unknown>>;
  allSuccess: boolean;
  stopped: boolean;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// ─── Execution ──────────────────────────────────────────────────────────────

/** Python `fnmatch.fnmatchcase` glob semantics for the `url` condition. */
function fnmatchCase(name: string, pattern: string): boolean {
  const re: string[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      re.push(".*");
    } else if (c === "?") {
      re.push(".");
    } else if (c === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) {
        re.push("\\[");
        continue;
      }
      let cls = pattern.slice(i + 1, close);
      if (cls.startsWith("!")) cls = "^" + cls.slice(1);
      else if (cls.startsWith("^")) cls = "\\^" + cls.slice(1);
      re.push(`[${cls}]`);
      i = close;
    } else {
      re.push(c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    }
  }
  return new RegExp(`^(?:${re.join("")})$`).test(name);
}

function substituteValue(value: unknown, getEnv: (key: string) => string): unknown {
  if (typeof value === "string") {
    return value.replace(ENV_RE, (_match, name: string) => getEnv(name));
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteValue(item, getEnv));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = substituteValue(v, getEnv);
    return out;
  }
  return value;
}

function extractOutput(result: ScriptDispatchResult): unknown {
  if (result._binary) return `data:image/png;base64,${toBase64(result._binary)}`;
  if (result.data !== undefined) return result.data;
  return result.extractedContent;
}

function stepLabel(step: Record<string, unknown>): string {
  for (const controlType of CONTROL_TYPES) {
    if (controlType in step) return controlType;
  }
  return String(step.action ?? "");
}

function formatStepResult(
  index: number,
  action: string,
  duration: number,
  result: Record<string, unknown>,
): Record<string, unknown> {
  const serialized = { ...result };
  delete serialized._binary;
  return { step: index, action, duration, ...serialized };
}

/**
 * Execute a validated script and return the exact result envelope.
 * Re-validates its input first (mirrors upstream `run_script`).
 */
export async function runScript(
  scriptData: unknown,
  dispatch: ScriptDispatchFn,
  options: ScriptRunOptions = {},
): Promise<ScriptRunEnvelope> {
  validateScript(scriptData);
  const script = scriptData as Record<string, unknown>;
  const getEnv = options.getEnv ?? (() => "");
  const name = (script.name ?? "unnamed") as string;
  const onError = script.on_error === "continue" ? "continue" : "stop";
  const steps = script.steps as Array<Record<string, unknown>>;
  const state: ExecutionState = { outputs: {}, loopStepExecutions: 0 };
  const startTime = performance.now();
  const { stepResults, allSuccess } = await executeSteps(steps, dispatch, onError, state, getEnv, false);
  const duration = round3((performance.now() - startTime) / 1000);
  const output: ScriptRunEnvelope = {
    name,
    success: allSuccess,
    steps_executed: stepResults.length,
    steps_total: steps.length,
    duration,
    step_results: stepResults,
  };
  if (Object.keys(state.outputs).length > 0) {
    output.outputs = state.outputs;
  }
  return output;
}

async function executeSteps(
  steps: Array<Record<string, unknown>>,
  dispatch: ScriptDispatchFn,
  onError: string,
  state: ExecutionState,
  getEnv: (key: string) => string,
  inLoop: boolean,
): Promise<ExecuteStepsResult> {
  const stepResults: Array<Record<string, unknown>> = [];
  let allSuccess = true;
  for (let index = 1; index <= steps.length; index++) {
    if (inLoop) {
      state.loopStepExecutions++;
      if (state.loopStepExecutions > MAX_LOOP_STEP_EXECUTIONS) {
        const limitResult: Record<string, unknown> = {
          success: false,
          error: "loop step execution limit exceeded",
        };
        stepResults.push(formatStepResult(index, "loop_limit", 0, limitResult));
        return { stepResults, allSuccess: false, stopped: true };
      }
    }
    const rawStep = steps[index - 1];
    const step = substituteValue(rawStep, getEnv) as Record<string, unknown>;
    const action = stepLabel(step);
    const startTime = performance.now();
    let result: Record<string, unknown>;
    if (CONTROL_TYPES.has(action)) {
      result = await executeControl(step, dispatch, onError, state, getEnv, inLoop);
    } else {
      result = await executeActionStep(step, dispatch, state);
    }
    const duration = round3((performance.now() - startTime) / 1000);
    stepResults.push(formatStepResult(index, action, duration, result));
    if (result.success === true) continue;
    allSuccess = false;
    if (onError === "stop") return { stepResults, allSuccess: false, stopped: true };
  }
  return { stepResults, allSuccess, stopped: false };
}

async function executeActionStep(
  step: Record<string, unknown>,
  dispatch: ScriptDispatchFn,
  state: ExecutionState,
): Promise<Record<string, unknown>> {
  let result: unknown;
  try {
    result = await dispatch(step);
  } catch {
    result = { success: false, error: "action dispatch failed" };
  }
  if (!isRecord(result)) {
    result = { success: false, error: "action dispatch returned an invalid result" };
  }
  const rec = result as ScriptDispatchResult;
  const outputId = step.output_id;
  if (typeof outputId === "string" && outputId !== "" && rec.success === true) {
    state.outputs[outputId] = extractOutput(rec);
  }
  // Spread into a plain object so the record-typed return value also carries
  // the step-level diagnostics (`data`, `extractedContent`, `error`) that
  // `formatStepResult` serializes into `step_results`.
  return { ...rec };
}

async function executeControl(
  step: Record<string, unknown>,
  dispatch: ScriptDispatchFn,
  onError: string,
  state: ExecutionState,
  getEnv: (key: string) => string,
  inLoop: boolean,
): Promise<Record<string, unknown>> {
  const controlType = stepLabel(step);
  const control = step[controlType] as Record<string, unknown>;
  if (controlType === "if") {
    return executeIf(control, dispatch, onError, state, getEnv, inLoop);
  }
  if (controlType === "repeat") {
    return executeRepeat(control, dispatch, onError, state, getEnv);
  }
  return executeWhile(control, dispatch, onError, state, getEnv);
}

async function executeIf(
  control: Record<string, unknown>,
  dispatch: ScriptDispatchFn,
  onError: string,
  state: ExecutionState,
  getEnv: (key: string) => string,
  inLoop: boolean,
): Promise<Record<string, unknown>> {
  let matched: boolean;
  try {
    matched = await waitForCondition(control.condition as Record<string, unknown>, dispatch, state.outputs);
  } catch {
    return { success: false, error: "condition evaluation failed" };
  }
  const branch = matched ? "then" : "else";
  const branchSteps = (control[branch] as Array<Record<string, unknown>> | undefined) ?? [];
  const nested = await executeSteps(branchSteps, dispatch, onError, state, getEnv, inLoop);
  return {
    success: nested.allSuccess,
    data: {
      matched,
      branch: branchSteps.length > 0 ? branch : "none",
      step_results: nested.stepResults,
    },
  };
}

async function executeRepeat(
  control: Record<string, unknown>,
  dispatch: ScriptDispatchFn,
  onError: string,
  state: ExecutionState,
  getEnv: (key: string) => string,
): Promise<Record<string, unknown>> {
  const iterations: Array<Record<string, unknown>> = [];
  let allSuccess = true;
  const count = control.count as number;
  const body = control.steps as Array<Record<string, unknown>>;
  for (let iteration = 1; iteration <= count; iteration++) {
    const nested = await executeSteps(body, dispatch, onError, state, getEnv, true);
    iterations.push({ iteration, step_results: nested.stepResults });
    if (nested.allSuccess) continue;
    allSuccess = false;
    if (nested.stopped) break;
  }
  return { success: allSuccess, data: { iterations, count } };
}

async function executeWhile(
  control: Record<string, unknown>,
  dispatch: ScriptDispatchFn,
  onError: string,
  state: ExecutionState,
  getEnv: (key: string) => string,
): Promise<Record<string, unknown>> {
  const iterations: Array<Record<string, unknown>> = [];
  let allSuccess = true;
  const maxIterations = control.max_iterations as number;
  const body = control.steps as Array<Record<string, unknown>>;
  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    let matched: boolean;
    try {
      matched = await waitForCondition(control.condition as Record<string, unknown>, dispatch, state.outputs);
    } catch {
      return { success: false, error: "condition evaluation failed" };
    }
    if (!matched) return { success: allSuccess, data: { iterations } };
    const nested = await executeSteps(body, dispatch, onError, state, getEnv, true);
    iterations.push({ iteration, step_results: nested.stepResults });
    if (!nested.allSuccess) allSuccess = false;
    if (!nested.allSuccess && nested.stopped) return { success: false, data: { iterations } };
  }
  let stillMatched: boolean;
  try {
    stillMatched = await waitForCondition(control.condition as Record<string, unknown>, dispatch, state.outputs);
  } catch {
    return { success: false, error: "condition evaluation failed" };
  }
  if (stillMatched) {
    return { success: false, error: "while loop reached max_iterations", data: { iterations } };
  }
  return { success: allSuccess, data: { iterations } };
}

async function waitForCondition(
  condition: Record<string, unknown>,
  dispatch: ScriptDispatchFn,
  outputs: Record<string, unknown>,
): Promise<boolean> {
  const timeout = typeof condition.timeout === "number" ? condition.timeout : 0;
  const deadline = performance.now() + timeout * 1000;
  for (;;) {
    if (await conditionMatches(condition, dispatch, outputs)) return true;
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    await sleep(Math.min(CONDITION_POLL_INTERVAL_MS, remaining));
  }
}

async function conditionMatches(
  condition: Record<string, unknown>,
  dispatch: ScriptDispatchFn,
  outputs: Record<string, unknown>,
): Promise<boolean> {
  const conditionType = condition.type as string;
  if (conditionType === "all") {
    for (const nested of condition.conditions as Array<Record<string, unknown>>) {
      if (!(await conditionMatches(nested, dispatch, outputs))) return false;
    }
    return true;
  }
  if (conditionType === "any") {
    for (const nested of condition.conditions as Array<Record<string, unknown>>) {
      if (await conditionMatches(nested, dispatch, outputs)) return true;
    }
    return false;
  }
  if (conditionType === "not") {
    return !(await conditionMatches(condition.condition as Record<string, unknown>, dispatch, outputs));
  }
  if (conditionType === "output") {
    return outputConditionMatches(condition, outputs);
  }
  if (conditionType === "element") {
    return elementConditionMatches(condition, dispatch);
  }
  if (conditionType === "text") {
    return pageBool(
      `document.body !== null && document.body.innerText.includes(${JSON.stringify(condition.text)})`,
      dispatch,
    );
  }
  if (conditionType === "url") {
    const url = await pageResult("location.href", dispatch);
    if (typeof url !== "string") throw new ConditionEvaluationError("URL condition returned a non-string");
    return fnmatchCase(url, condition.matches as string);
  }
  return pageBool(condition.expression as string, dispatch);
}

async function elementConditionMatches(
  condition: Record<string, unknown>,
  dispatch: ScriptDispatchFn,
): Promise<boolean> {
  const selector = JSON.stringify(condition.selector);
  const state = typeof condition.state === "string" ? condition.state : "visible";
  const stateLiteral = JSON.stringify(state);
  const expression = `(() => {
        const element = document.querySelector(${selector});
        if (!element) return ${state === "detached" || state === "hidden"};
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const visible = style.display !== 'none' && style.visibility !== 'hidden'
            && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
        if (${stateLiteral} === 'attached') return true;
        if (${stateLiteral} === 'detached') return false;
        if (${stateLiteral} === 'hidden') return !visible;
        return visible;
    })()`;
  return pageBool(expression, dispatch);
}

/** Evaluate an expression, accepting either a real boolean or a "true"/"false" string. */
async function pageBool(expression: string, dispatch: ScriptDispatchFn): Promise<boolean> {
  const result = await pageResult(expression, dispatch);
  if (result === true || result === "true") return true;
  if (result === false || result === "false") return false;
  throw new ConditionEvaluationError("condition must evaluate to boolean");
}

async function pageResult(expression: string, dispatch: ScriptDispatchFn): Promise<unknown> {
  let response: ScriptDispatchResult;
  try {
    response = await dispatch({ action: "eval", expression });
  } catch {
    throw new ConditionEvaluationError("condition dispatch failed");
  }
  if (!isRecord(response) || response.success !== true) {
    throw new ConditionEvaluationError("condition dispatch failed");
  }
  if (typeof response.extractedContent === "string") return response.extractedContent;
  const data = response.data;
  if (isRecord(data) && "result" in data) return (data as { result: unknown }).result;
  return data;
}

function outputConditionMatches(condition: Record<string, unknown>, outputs: Record<string, unknown>): boolean {
  const { exists, value } = getOutputPath(
    outputs,
    condition.output_id as string,
    (condition.path as unknown[] | undefined) ?? [],
  );
  if ("exists" in condition) return exists === condition.exists;
  return exists && value === condition.equals;
}

function getOutputPath(
  outputs: Record<string, unknown>,
  outputId: string,
  path: unknown[],
): { exists: boolean; value: unknown } {
  if (!Object.prototype.hasOwnProperty.call(outputs, outputId)) return { exists: false, value: undefined };
  let value: unknown = outputs[outputId];
  for (const segment of path) {
    if (
      isRecord(value) &&
      typeof segment === "string" &&
      Object.prototype.hasOwnProperty.call(value, segment)
    ) {
      value = value[segment];
      continue;
    }
    if (
      Array.isArray(value) &&
      typeof segment === "number" &&
      Number.isInteger(segment) &&
      segment >= 0 &&
      segment < value.length
    ) {
      value = value[segment];
      continue;
    }
    return { exists: false, value: undefined };
  }
  return { exists: true, value };
}
