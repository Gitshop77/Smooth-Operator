/**
 * Structural validation for the S3 script format — the validation half of the
 * script engine (port of stealthy-auto-browse's `script_runner.py`), split
 * out of `script-runner.ts` so the grammar rules live beside the constants
 * that constrain them. `validateScript` throws {@link ScriptValidationError}
 * with the pinned upstream messages.
 */

// ─── Limits (mirror upstream constants) ─────────────────────────────────────

const MAX_CONTROL_FLOW_DEPTH = 8;
const MAX_CONDITION_DEPTH = 8;
const MAX_LOOP_ITERATIONS = 100;
const MAX_CONDITION_TIMEOUT_SECONDS = 60;

const CONTROL_TYPES = new Set(["if", "repeat", "while"]);
const CONDITION_TYPES = new Set(["all", "any", "element", "javascript", "not", "output", "text", "url"]);
const ELEMENT_STATES = new Set(["attached", "detached", "hidden", "visible"]);

// ─── Validation (exact upstream messages) ───────────────────────────────────

/** Raised for any script structure that cannot be safely executed. */
export class ScriptValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a parsed script's structure before execution. Throws
 * {@link ScriptValidationError} with the pinned upstream messages.
 */
export function validateScript(scriptData: unknown): void {
  if (!isRecord(scriptData)) {
    throw new ScriptValidationError("Invalid script: expected a YAML mapping");
  }
  const steps = scriptData.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new ScriptValidationError("Invalid script: steps must be a non-empty list");
  }
  if (scriptData.on_error !== undefined && scriptData.on_error !== "stop" && scriptData.on_error !== "continue") {
    throw new ScriptValidationError("Invalid script: on_error must be 'stop' or 'continue'");
  }
  validateSteps(steps, 0, false);
}

function validateSteps(steps: unknown, depth: number, allowEmpty: boolean): void {
  if (!Array.isArray(steps)) {
    throw new ScriptValidationError("Invalid script: step block must be a list");
  }
  if (!allowEmpty && steps.length === 0) {
    throw new ScriptValidationError("Invalid script: step block must not be empty");
  }
  for (const step of steps) validateStep(step, depth);
}

function validateStep(step: unknown, depth: number): void {
  if (!isRecord(step)) {
    throw new ScriptValidationError("Invalid script: every step must be a mapping");
  }
  const controlTypes = [...CONTROL_TYPES].filter((t) => t in step);
  if (controlTypes.length > 1) {
    throw new ScriptValidationError("Invalid script: a step may contain one control node");
  }
  if (controlTypes.length > 0 && "action" in step) {
    throw new ScriptValidationError("Invalid script: a control node cannot include action");
  }
  if (controlTypes.length === 0) {
    const action = step.action;
    if (typeof action !== "string" || action === "") {
      throw new ScriptValidationError("Invalid script: action step requires a non-empty action");
    }
    if ("output_id" in step) {
      validateNonEmptyString(step.output_id, "action output_id");
    }
    return;
  }
  if (depth >= MAX_CONTROL_FLOW_DEPTH) {
    throw new ScriptValidationError("Invalid script: control-flow nesting limit exceeded");
  }
  const controlType = controlTypes[0];
  if (Object.keys(step).length !== 1) {
    throw new ScriptValidationError("Invalid script: control nodes cannot have sibling fields");
  }
  const control = step[controlType];
  if (!isRecord(control)) {
    throw new ScriptValidationError("Invalid script: control node must be a mapping");
  }
  if (controlType === "if") {
    validateIfControl(control, depth);
    return;
  }
  if (controlType === "repeat") {
    validateRepeatControl(control, depth);
    return;
  }
  validateWhileControl(control, depth);
}

function validateIfControl(control: Record<string, unknown>, depth: number): void {
  const allowed = new Set(["condition", "else", "then"]);
  const hasExtra = Object.keys(control).some((k) => !allowed.has(k));
  if (hasExtra || !("condition" in control) || !("then" in control)) {
    throw new ScriptValidationError("Invalid script: if requires condition and then");
  }
  validateCondition(control.condition, true, 0);
  validateSteps(control.then, depth + 1, true);
  if ("else" in control) validateSteps(control.else, depth + 1, true);
}

function validateRepeatControl(control: Record<string, unknown>, depth: number): void {
  if (Object.keys(control).length !== 2 || !("count" in control) || !("steps" in control)) {
    throw new ScriptValidationError("Invalid script: repeat requires only count and steps");
  }
  validateLoopBound(control.count, "repeat count");
  validateSteps(control.steps, depth + 1, false);
}

function validateWhileControl(control: Record<string, unknown>, depth: number): void {
  if (
    Object.keys(control).length !== 3 ||
    !("condition" in control) ||
    !("max_iterations" in control) ||
    !("steps" in control)
  ) {
    throw new ScriptValidationError("Invalid script: while requires condition, max_iterations, and steps");
  }
  validateCondition(control.condition, true, 0);
  validateLoopBound(control.max_iterations, "while max_iterations");
  validateSteps(control.steps, depth + 1, false);
}

function validateLoopBound(value: unknown, label: string): void {
  if (typeof value === "boolean" || typeof value !== "number" || !Number.isInteger(value)) {
    throw new ScriptValidationError(`Invalid script: ${label} must be an integer`);
  }
  if (value < 1 || value > MAX_LOOP_ITERATIONS) {
    throw new ScriptValidationError(`Invalid script: ${label} must be between 1 and ${MAX_LOOP_ITERATIONS}`);
  }
}

function validateCondition(condition: unknown, allowTimeout: boolean, depth: number): void {
  if (!isRecord(condition)) {
    throw new ScriptValidationError("Invalid script: condition must be a mapping");
  }
  if (depth >= MAX_CONDITION_DEPTH) {
    throw new ScriptValidationError("Invalid script: condition nesting limit exceeded");
  }
  const conditionType = condition.type;
  if (typeof conditionType !== "string" || !CONDITION_TYPES.has(conditionType)) {
    throw new ScriptValidationError("Invalid script: unsupported condition type");
  }
  const allowedFields: Record<string, Set<string>> = {
    all: new Set(["conditions", "timeout", "type"]),
    any: new Set(["conditions", "timeout", "type"]),
    element: new Set(["selector", "state", "timeout", "type"]),
    javascript: new Set(["expression", "timeout", "type"]),
    not: new Set(["condition", "timeout", "type"]),
    output: new Set(["equals", "exists", "output_id", "path", "timeout", "type"]),
    text: new Set(["text", "timeout", "type"]),
    url: new Set(["matches", "timeout", "type"]),
  };
  const allowed = allowedFields[conditionType];
  const hasUnknownField = Object.keys(condition).some((k) => !allowed.has(k));
  if (hasUnknownField) {
    throw new ScriptValidationError("Invalid script: unsupported condition field");
  }
  if ("timeout" in condition) {
    if (!allowTimeout) {
      throw new ScriptValidationError("Invalid script: nested conditions cannot set timeout");
    }
    validateTimeout(condition.timeout);
  }
  switch (conditionType) {
    case "element": {
      validateNonEmptyString(condition.selector, "element selector");
      const state = condition.state ?? "visible";
      if (typeof state !== "string" || !ELEMENT_STATES.has(state)) {
        throw new ScriptValidationError("Invalid script: unsupported element state");
      }
      return;
    }
    case "text":
      validateNonEmptyString(condition.text, "text condition text");
      return;
    case "url":
      validateNonEmptyString(condition.matches, "url condition matches");
      return;
    case "javascript":
      validateNonEmptyString(condition.expression, "javascript condition expression");
      return;
    case "output": {
      validateNonEmptyString(condition.output_id, "output condition output_id");
      const hasEquals = "equals" in condition;
      const hasExists = "exists" in condition;
      if (hasEquals === hasExists) {
        throw new ScriptValidationError("Invalid script: output condition requires exactly one of equals or exists");
      }
      if (hasExists && typeof condition.exists !== "boolean") {
        throw new ScriptValidationError("Invalid script: output condition exists must be boolean");
      }
      validateOutputPath(condition.path ?? []);
      return;
    }
    case "all":
    case "any": {
      const conditions = condition.conditions;
      if (!Array.isArray(conditions) || conditions.length === 0) {
        throw new ScriptValidationError("Invalid script: all and any require a non-empty conditions list");
      }
      for (const nested of conditions) validateCondition(nested, false, depth + 1);
      return;
    }
    default: {
      if (!("condition" in condition)) {
        throw new ScriptValidationError("Invalid script: not requires condition");
      }
      validateCondition(condition.condition, false, depth + 1);
    }
  }
}

function validateTimeout(value: unknown): void {
  if (typeof value === "boolean" || typeof value !== "number") {
    throw new ScriptValidationError("Invalid script: condition timeout must be a number");
  }
  if (!Number.isFinite(value)) {
    throw new ScriptValidationError("Invalid script: condition timeout must be finite");
  }
  if (value < 0 || value > MAX_CONDITION_TIMEOUT_SECONDS) {
    throw new ScriptValidationError("Invalid script: condition timeout is outside range");
  }
}

function validateOutputPath(path: unknown): void {
  if (!Array.isArray(path)) {
    throw new ScriptValidationError("Invalid script: output condition path must be a list");
  }
  for (const segment of path) {
    if (typeof segment === "boolean") {
      throw new ScriptValidationError("Invalid script: output condition path is invalid");
    }
    if (typeof segment === "string" && segment !== "") continue;
    if (typeof segment === "number" && Number.isInteger(segment) && segment >= 0) continue;
    throw new ScriptValidationError("Invalid script: output condition path is invalid");
  }
}

function validateNonEmptyString(value: unknown, label: string): void {
  if (typeof value !== "string" || value === "") {
    throw new ScriptValidationError(`Invalid script: ${label} must be a non-empty string`);
  }
}

/** Grammar shared with the execution engine (control-node detection). */
export { CONTROL_TYPES };

/** Record guard shared with the execution engine. */
export { isRecord };
