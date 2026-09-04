import type { CallToolResult } from "@modelcontextprotocol/server";

import { redactValue } from "./logger";

type ErrorDetails = Record<string, unknown>;
type ErrorRecovery = { tool: string; instruction: string; arguments?: Record<string, unknown> };
const ERROR_CODE_MAX_CHARS = 200;
const ERROR_MESSAGE_MAX_CHARS = 4_000;
const ERROR_DETAILS_MAX_BYTES = 8_000;
const ERROR_DETAIL_VALUE_MAX_CHARS = 1_000;
const ERROR_TRUNCATION_MARKER = "…[TRUNCATED]";
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const UTF8_ENCODER = new TextEncoder();
const ERROR_TRUNCATION_MARKER_BYTES = UTF8_ENCODER.encode(ERROR_TRUNCATION_MARKER).byteLength;

export class AppError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: ErrorDetails;
  readonly status: number;

  constructor(
    code: string,
    message: string,
    options: {
      retryable?: boolean;
      details?: ErrorDetails;
      status?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
    this.status = options.status ?? 400;
  }
}

export function asAppError(error: unknown, fallbackCode = "INTERNAL_ERROR"): AppError {
  if (error instanceof AppError) {
    return error;
  }

  // Error messages often contain filesystem paths, command lines, request
  // URLs, or other operational details.  They are useful in a local
  // debugger, but are not a safe protocol response.  Keep the original error
  // as `cause` for server-side diagnostics while exposing one stable message
  // to MCP clients.
  return new AppError(fallbackCode, "An unexpected error occurred.", { cause: error, status: 500 });
}

/** Return bounded, redacted diagnostics. Omits `cause` which may contain secrets. */
export function safeErrorDiagnostic(error: unknown): { code: string; message: string; retryable: boolean } {
  const normalized = asAppError(error);
  return {
    code: safeErrorCode(normalized.code),
    message: safeErrorMessage(normalized.message),
    retryable: normalized.retryable,
  } as {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export function safeErrorPayload(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
  details?: ErrorDetails;
  recovery?: ErrorRecovery;
} {
  const normalized = asAppError(error);
  const code = safeErrorCode(normalized.code);
  const recovery = recoveryForCode(code);
  const payload = {
    code,
    message: safeErrorMessage(normalized.message),
    retryable: normalized.retryable,
    ...(normalized.details ? { details: boundErrorDetails(normalized.details) } : {}),
    ...(recovery ? { recovery } : {}),
  };

  return payload as typeof payload;
}

function recoveryForCode(code: string): ErrorRecovery | undefined {
  switch (code) {
    case "STALE_REFERENCE":
    case "STALE_SNAPSHOT":
      return { tool: "browser_snapshot", instruction: "Capture a fresh browser snapshot, then retry with its ref or index." };
    case "STALE_PAGE_SLICE":
      return { tool: "browser_extract", instruction: "Extract the current page again, then retry with its nextOffset and revision." };
    case "FRAME_NOT_FOUND":
    case "FRAME_MISMATCH":
      return { tool: "browser_frames", instruction: "List current frames, then retry with a fresh frameId." };
    case "ELEMENT_NOT_FOUND":
    case "ELEMENT_NOT_VISIBLE":
      return { tool: "browser_snapshot", instruction: "Capture a fresh browser snapshot and choose a current visible target." };
    case "DIALOG_PENDING":
      return { tool: "browser_dialog", instruction: "Read the pending dialog text before continuing.", arguments: { operation: "get_text" } };
    case "BROWSER_RECOVERY_REQUIRED":
      return { tool: "browser_list_sessions", instruction: "Use the returned session_id with browser_close_session before retrying." };
    default:
      return undefined;
  }
}

export function toolError(error: unknown): CallToolResult {
  const payload = safeErrorPayload(error);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: payload }) }],
    structuredContent: { ok: false, error: payload },
  };
}

export function toolResult<T>(value: T): CallToolResult {
  const safeValue = redactValue(value);
  // MCP structuredContent is object-shaped on the wire. Preserve the direct
  // JSON text fallback for arrays/primitives while giving clients a valid,
  // predictable object for structured consumption.
  const structuredContent = isRecord(safeValue) ? safeValue : { value: safeValue };
  return {
    content: [{ type: "text", text: JSON.stringify(safeValue) }],
    structuredContent,
  };
}

export function requireField<T>(value: T | undefined, field: string): T {
  if (value === undefined || value === null || value === "") {
    throw new AppError("INVALID_ACTION", `The '${field}' field is required.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeErrorCode(value: unknown): string {
  if (typeof value !== "string") {
    return "INTERNAL_ERROR";
  }
  const code = truncateUtf8(value, ERROR_CODE_MAX_CHARS);
  return ERROR_CODE_PATTERN.test(code) ? code : "INTERNAL_ERROR";
}

function safeErrorMessage(value: unknown): string {
  const redacted = redactValue(typeof value === "string" ? value : "An unexpected error occurred.");
  const message = typeof redacted === "string" ? redacted : "An unexpected error occurred.";
  return truncateWithMarker(message, ERROR_MESSAGE_MAX_CHARS);
}

function boundErrorDetails(value: unknown): ErrorDetails {
  const safe = redactValue(value);
  if (jsonByteLength(safe) <= ERROR_DETAILS_MAX_BYTES) {
    return isRecord(safe) ? safe : { value: safe };
  }
  if (!isRecord(safe)) {
    return {
      truncated: true,
      mcpOutputTruncated: true,
      warning: "Error details were omitted because they exceeded the MCP response budget.",
    };
  }

  const bounded = Object.create(null) as ErrorDetails;
  const copyScalar = (key: string): void => {
    const item = safe[key];
    if (typeof item === "string") {
      bounded[key] = truncateUtf8(item, ERROR_DETAIL_VALUE_MAX_CHARS);
    } else if (typeof item === "number" || typeof item === "boolean" || item === null) {
      bounded[key] = item;
    }
  };
  for (const key of [
    "classification", "status", "attempts", "maxAttempts", "retryAfterMs", "timeoutMs",
    "failedIndex", "failedAction", "completedActions", "hint", "warning", "truncated",
    "mcpOutputTruncated", "omittedItems", "resultsTruncated", "omittedResults",
  ]) {
    copyScalar(key);
  }

  for (const key of ["issues", "completedResults"]) {
    const sourceItems = safe[key];
    if (!Array.isArray(sourceItems)) {
      continue;
    }
    const retained: unknown[] = [];
    for (const item of sourceItems) {
      const boundedItem = typeof item === "string"
        ? truncateWithMarker(item, ERROR_DETAIL_VALUE_MAX_CHARS)
        : jsonByteLength(item) <= ERROR_DETAIL_VALUE_MAX_CHARS ? item : { truncated: true };
      const candidate = { ...bounded, [key]: [...retained, boundedItem] };
      if (jsonByteLength(candidate) > ERROR_DETAILS_MAX_BYTES - 256) {
        break;
      }
      retained.push(boundedItem);
    }
    bounded[key] = retained;
    if (retained.length < sourceItems.length) {
      if (key === "completedResults") {
        bounded.resultsTruncated = true;
        bounded.omittedResults = sourceItems.length - retained.length;
      } else {
        bounded.issuesTruncated = true;
        bounded.omittedIssues = sourceItems.length - retained.length;
      }
    }
  }

  if (jsonByteLength(bounded) <= ERROR_DETAILS_MAX_BYTES) {
    return bounded;
  }
  return {
    truncated: true,
    mcpOutputTruncated: true,
    warning: "Error details were omitted because they exceeded the MCP response budget.",
  };
}

function jsonByteLength(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function truncateWithMarker(value: string, maxBytes: number): string {
  const bytes = UTF8_ENCODER.encode(value);
  if (bytes.byteLength <= maxBytes) {
    return value;
  }
  const markerBytes = ERROR_TRUNCATION_MARKER_BYTES;
  return `${truncateUtf8(value, Math.max(0, maxBytes - markerBytes))}${ERROR_TRUNCATION_MARKER}`;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = UTF8_ENCODER.encode(value);
  const boundedMaxBytes = Math.max(0, Math.floor(maxBytes));
  if (bytes.byteLength <= boundedMaxBytes) {
    return value;
  }
  if (bytes.byteLength === value.length) {
    return value.slice(0, boundedMaxBytes);
  }
  const decoder = new TextDecoder();
  let low = 0;
  let high = Math.min(bytes.byteLength, boundedMaxBytes);
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    const candidate = decoder.decode(bytes.slice(0, midpoint));
    if (UTF8_ENCODER.encode(candidate).byteLength <= boundedMaxBytes) {
      low = midpoint;
    } else {
      high = midpoint - 1;
    }
  }
  return decoder.decode(bytes.slice(0, low));
}
