import { stderr } from "node:process";

export type LogLevel = "debug" | "info" | "warn" | "error";
type LogFields = Record<string, unknown>;
type LogSink = (line: string) => void;

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SECRET_KEY_PATTERN = /(api[-_]?key|authorization|cookie|password|secret|token|credential|private[-_]?key)/i;
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /bearer\s+[a-z0-9._~+/=-]{12,}/gi,
  /sk-[a-z0-9_-]{12,}/gi,
  /AIza[a-z0-9_-]{20,}/gi,
  /xai-[a-z0-9_-]{12,}/gi,
];
const SECRET_QUERY_PATTERN = /([?&](?:access[_-]?token|api[_-]?key|auth|code|credential|jwt|nonce|otp|password|secret|session|sig(?:nature)?|token)=[^&#\s]*)/gi;
const MAX_STRING_CHARS = 50_000;
const MAX_COLLECTION_ITEMS = 200;
const MAX_OBJECT_KEY_CHARS = 200;
const MAX_REDACTED_CHARS = 1_000_000;
const MAX_DEPTH = 8;

interface RedactionBudget {
  remaining: number;
}

/** Return a bounded unique projection for each source key. Collision suffixes prevent silent replacement. */
function uniqueObjectKey(key: string, usedKeys: Set<string>): string {
  const base = key.length > MAX_OBJECT_KEY_CHARS ? `${key.slice(0, MAX_OBJECT_KEY_CHARS)}…` : key;
  if (!usedKeys.has(base)) {
    usedKeys.add(base);
    return base;
  }

  for (let occurrence = 2; ; occurrence += 1) {
    const suffix = `~${occurrence}`;
    const prefixLength = key.length > MAX_OBJECT_KEY_CHARS
      ? Math.max(1, MAX_OBJECT_KEY_CHARS - suffix.length - 1)
      : Math.max(1, MAX_OBJECT_KEY_CHARS - suffix.length);
    const candidate = key.length > MAX_OBJECT_KEY_CHARS
      ? `${key.slice(0, prefixLength)}…${suffix}`
      : `${key.slice(0, prefixLength)}${suffix}`;
    if (!usedKeys.has(candidate)) {
      usedKeys.add(candidate);
      return candidate;
    }
  }
}

function redactString(value: string, budget: RedactionBudget): string {
  const wasTruncated = value.length > MAX_STRING_CHARS;
  const input = wasTruncated ? value.slice(0, MAX_STRING_CHARS) : value;
  let redacted = input.replace(/%[A-Za-z_][A-Za-z0-9_]{0,127}%/g, "[SECRET_PLACEHOLDER]");
  redacted = redacted.replace(SECRET_QUERY_PATTERN, "[REDACTED_QUERY]");
  for (const pattern of SECRET_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  const bounded = wasTruncated ? `${redacted.slice(0, MAX_STRING_CHARS)}…[TRUNCATED]` : redacted;
  if (bounded.length <= budget.remaining) {
    budget.remaining -= bounded.length;
    return bounded;
  }
  const available = Math.max(0, budget.remaining);
  budget.remaining = 0;
  return bounded.slice(0, available);
}

export function redactValue(value: unknown, depth = 0): unknown {
  return redactValueWithBudget(value, depth, { remaining: MAX_REDACTED_CHARS }, new WeakSet<object>());
}

function redactValueWithBudget(value: unknown, depth: number, budget: RedactionBudget, seen: WeakSet<object>): unknown {
  if (depth > MAX_DEPTH) {
    return "[DEPTH_LIMIT]";
  }
  // MCP JSON content and structured logs cannot represent these JavaScript
  // values. Normalize them before they reach JSON.stringify so a malformed
  // or partially failed operation cannot emit an invalid response.
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return null;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return null;
  }
  if (typeof value === "string") {
    return redactString(value, budget);
  }
  if (typeof value === "bigint") {
    return redactString(`${value}n`, budget);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[CIRCULAR]";
    }
    seen.add(value);
    const result: unknown[] = [];
    for (const item of value.slice(0, MAX_COLLECTION_ITEMS)) {
      if (budget.remaining === 0) {
        break;
      }
      result.push(redactValueWithBudget(item, depth + 1, budget, seen));
    }
    seen.delete(value);
    return result;
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) {
      return "[CIRCULAR]";
    }
    seen.add(value);
    const result = Object.create(null) as Record<string, unknown>;
    const source = value as Record<string, unknown>;
    const usedKeys = new Set<string>();
    let entryCount = 0;
    let truncated = false;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) {
        continue;
      }
      if (entryCount >= MAX_COLLECTION_ITEMS) {
        truncated = true;
        break;
      }
      if (budget.remaining === 0) {
        break;
      }
      const item = source[key];
      const safeKey = uniqueObjectKey(key, usedKeys);
      result[safeKey] = SECRET_KEY_PATTERN.test(key)
        ? redactString("[REDACTED]", budget)
        : redactValueWithBudget(item, depth + 1, budget, seen);
      entryCount += 1;
    }
    if (truncated || budget.remaining === 0) {
      // Keep the metadata flag authoritative even when the input itself has
      // an enumerable `__truncated` key.  Move that source value to a unique
      // projection instead of overwriting it.
      if (Object.hasOwn(result, "__truncated")) {
        const originalValue = result.__truncated;
        delete result.__truncated;
        result[uniqueObjectKey("__truncated", usedKeys)] = originalValue;
      }
      usedKeys.add("__truncated");
      result.__truncated = true;
    }
    seen.delete(value);
    return result;
  }
  return value;
}

export class Logger {
  private readonly minLevel: LogLevel;
  private readonly minWeight: number;
  private readonly context: LogFields;
  private readonly sink: LogSink;

  constructor(
    minLevel: LogLevel = "info",
    context: LogFields = {},
    sink: LogSink = (line) => stderr.write(`${line}\n`),
  ) {
    this.minLevel = minLevel;
    this.minWeight = LEVEL_WEIGHT[minLevel];
    this.context = context;
    this.sink = sink;
  }

  child(context: LogFields): Logger {
    return new Logger(this.minLevel, { ...this.context, ...context }, this.sink);
  }

  get level(): LogLevel {
    return this.minLevel;
  }

  debug(message: string, fields: LogFields = {}): void {
    this.write("debug", message, fields);
  }

  info(message: string, fields: LogFields = {}): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields: LogFields = {}): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields: LogFields = {}): void {
    this.write("error", message, fields);
  }

  private write(level: LogLevel, message: string, fields: LogFields): void {
    if (LEVEL_WEIGHT[level] < this.minWeight) {
      return;
    }

    const line = redactValue({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...this.context,
      ...fields,
    });
    this.sink(JSON.stringify(line));
  }
}
