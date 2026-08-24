import type { CallToolResult } from "@modelcontextprotocol/server";

import { redactValue } from "./logger";

type ErrorDetails = Record<string, unknown>;

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

/**
 * Return bounded, redacted diagnostics for server logs.  This deliberately
 * omits `cause`: a cause may contain a stack, path, request body, or secret
 * that should never be copied into structured log fields.
 */
export function safeErrorDiagnostic(error: unknown): { code: string; message: string; retryable: boolean } {
  const normalized = asAppError(error);
  return redactValue({ code: normalized.code, message: normalized.message, retryable: normalized.retryable }) as {
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
} {
  const normalized = asAppError(error);
  const payload = {
    code: normalized.code,
    message: normalized.message,
    retryable: normalized.retryable,
    ...(normalized.details ? { details: normalized.details } : {}),
  };

  return redactValue(payload) as typeof payload;
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

export async function callTool<T>(operation: () => Promise<T>, onError?: (error: unknown) => void): Promise<CallToolResult> {
  try {
    return toolResult(await operation());
  } catch (error) {
    try {
      onError?.(error);
    } catch {
      // Diagnostics must never change the protocol response path.
    }
    return toolError(error);
  }
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
