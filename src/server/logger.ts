import { stderr } from "node:process";

export type LogLevel = "debug" | "info" | "warn" | "error";
type LogFields = Record<string, unknown>;
type LogSink = (line: string) => void;
const EMPTY_FIELDS: LogFields = Object.freeze({});

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
const UNREADABLE_OBJECT = "[UNREADABLE_OBJECT]";
const UNREADABLE_PROPERTY = "[UNREADABLE_PROPERTY]";

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
  let isArray = false;
  try {
    isArray = Array.isArray(value);
  } catch {
    return UNREADABLE_OBJECT;
  }
  if (isArray) {
    const array = value as unknown[];
    if (seen.has(array)) {
      return "[CIRCULAR]";
    }
    seen.add(array);
    const result: unknown[] = [];
    let length = 0;
    try {
      const rawLength = (array as unknown as { length?: unknown }).length;
      length = typeof rawLength === "number" && Number.isSafeInteger(rawLength) && rawLength >= 0 ? rawLength : 0;
    } catch {
      seen.delete(array);
      return UNREADABLE_OBJECT;
    }
    const itemCount = Math.min(length, MAX_COLLECTION_ITEMS);
    for (let index = 0; index < itemCount; index += 1) {
      if (budget.remaining === 0) {
        break;
      }
      try {
        result.push(redactValueWithBudget(array[index], depth + 1, budget, seen));
      } catch {
        result.push(UNREADABLE_PROPERTY);
      }
    }
    seen.delete(array);
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
    try {
      // A bounded for-in walk avoids materializing an attacker-sized key
      // array for ordinary objects while the own-property check preserves
      // the prototype-safe projection. Proxy enumeration failures still
      // fail closed through the surrounding catch.
      for (const key in source) {
        if (!Object.hasOwn(source, key)) {
          continue;
        }
        if (entryCount >= MAX_COLLECTION_ITEMS) {
          truncated = true;
          break;
        }
        if (budget.remaining === 0) {
          break;
        }
        const safeKey = uniqueObjectKey(key, usedKeys);
        if (SECRET_KEY_PATTERN.test(key)) {
          result[safeKey] = redactString("[REDACTED]", budget);
        } else {
          try {
            result[safeKey] = redactValueWithBudget(source[key], depth + 1, budget, seen);
          } catch {
            result[safeKey] = UNREADABLE_PROPERTY;
          }
        }
        entryCount += 1;
      }
    } catch {
      seen.delete(value);
      return UNREADABLE_OBJECT;
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

  debug(message: string, fields?: LogFields): void {
    this.write("debug", message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.write("error", message, fields);
  }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_WEIGHT[level] < this.minWeight) {
      return;
    }

    try {
      const line = redactValue({
        timestamp: new Date().toISOString(),
        level,
        message,
        ...this.context,
        ...(fields ?? EMPTY_FIELDS),
      });
      this.sink(JSON.stringify(line));
    } catch {
      // Logging is best-effort. A closed or failing sink must not mask the
      // protocol response or alter browser-control flow.
    }
  }
}
