import type { CallToolResult } from "@modelcontextprotocol/server";

import { MCP_PAGE_TEXT_MAX_CHARS, RESEARCH_MAX_RESULTS } from "./contracts";
import { AppError, safeErrorDiagnostic, toolError } from "./errors";
import { redactValue } from "./logger";
import type { ServerRuntime } from "./runtime";

/** Keep each copy below half of the 65,536-byte record budget. */
const MCP_OUTPUT_MAX_BYTES = 28_000;
const MCP_IMAGE_MAX_BYTES = 8_000_000;
const MCP_OUTPUT_TEXT_MAX_BYTES = 20_000;
const MCP_OUTPUT_LINK_LIMIT = 4;
const MCP_OUTPUT_RESULT_LIMIT = RESEARCH_MAX_RESULTS;
export const MCP_WEB_SEARCH_DEFAULT_RESULT_LIMIT = 5;
const MCP_OUTPUT_ARRAY_ITEM_LIMIT = 200;
const MCP_OUTPUT_INTERACTIVE_LIMIT = 80;
const MCP_OUTPUT_ENTRY_LIMIT = 20;
const MCP_OUTPUT_NODE_LIMIT = 80;
const MCP_OUTPUT_MATCH_LIMIT = 12;
const UTF8_ENCODER = new TextEncoder();
const MCP_OUTPUT_TRUNCATION_MARKER = "\n[MCP_OUTPUT_TRUNCATED]\n";
const MCP_OUTPUT_TRUNCATION_MARKER_BYTES = UTF8_ENCODER.encode(MCP_OUTPUT_TRUNCATION_MARKER).byteLength;
const MCP_ERROR_CODE_MAX_BYTES = 200;
const MCP_ERROR_MESSAGE_MAX_BYTES = 4_000;
const MCP_JSON_TEXT_CACHE = new WeakMap<object, string>();
const MCP_OUTPUT_CONTRACT_ARRAY_KEYS: ReadonlySet<string> = new Set([
  "links",
  "results",
  "entries",
  "interactive",
  "nodes",
  "matches",
  "frames",
]);
const MCP_OUTPUT_ARRAY_BOUNDS: ReadonlyArray<readonly [string, string]> = [
  ["links", "linksTruncated"],
  ["entries", "entriesTruncated"],
  ["interactive", "interactiveTruncated"],
  ["nodes", "nodesTruncated"],
  ["matches", "matchesTruncated"],
  ["frames", "framesTruncated"],
];

export type McpOutputOptions = { preserveBatchResults?: boolean; resultLimit?: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function jsonByteLength(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function jsonText(value: unknown): string {
  if (value !== null && typeof value === "object") {
    const cached = MCP_JSON_TEXT_CACHE.get(value);
    if (cached !== undefined) {
      return cached;
    }
    const text = JSON.stringify(value) ?? "null";
    MCP_JSON_TEXT_CACHE.set(value, text);
    return text;
  }
  return JSON.stringify(value) ?? "null";
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

function truncateMcpText(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (UTF8_ENCODER.encode(value).byteLength <= maxBytes) {
    return { value, truncated: false };
  }
  const markerBytes = MCP_OUTPUT_TRUNCATION_MARKER_BYTES;
  const wrapped = /^(<untrusted_[a-z0-9_]+>)([\s\S]*)(<\/untrusted_[a-z0-9_]+>)$/i.exec(value);
  if (wrapped) {
    const fixedBytes = UTF8_ENCODER.encode(`${wrapped[1]}${wrapped[3]}`).byteLength + markerBytes;
    if (fixedBytes < maxBytes) {
      const inner = truncateUtf8(wrapped[2], maxBytes - fixedBytes);
      return { value: `${wrapped[1]}${inner}${MCP_OUTPUT_TRUNCATION_MARKER}${wrapped[3]}`, truncated: true };
    }
  }
  return {
    value: `${truncateUtf8(value, Math.max(0, maxBytes - markerBytes))}${MCP_OUTPUT_TRUNCATION_MARKER}`,
    truncated: true,
  };
}

function untrustedPayloadLength(value: string): number {
  const wrapped = /^<untrusted_[a-z0-9_]+>([\s\S]*)<\/untrusted_[a-z0-9_]+>$/i.exec(value);
  return wrapped ? wrapped[1].length : value.length;
}

function boundMcpArray(value: unknown[]): unknown {
  const items: unknown[] = [];
  let serializedBytes = 2;
  for (const item of value.slice(0, MCP_OUTPUT_ARRAY_ITEM_LIMIT)) {
    let itemBytes: number;
    try {
      const json = JSON.stringify(item);
      itemBytes = json === undefined ? 4 : UTF8_ENCODER.encode(json).byteLength;
    } catch {
      itemBytes = Number.POSITIVE_INFINITY;
    }
    const candidateBytes = serializedBytes + (items.length > 0 ? 1 : 0) + itemBytes;
    if (candidateBytes > MCP_OUTPUT_MAX_BYTES - 1_000) {
      break;
    }
    items.push(item);
    serializedBytes = candidateBytes;
  }
  if (items.length === value.length && value.length <= MCP_OUTPUT_ARRAY_ITEM_LIMIT) {
    return value;
  }
  return {
    items,
    truncated: true,
    mcpOutputTruncated: true,
    omittedItems: Math.max(0, value.length - items.length),
    warning: "The MCP result exceeded the client record budget; use a narrower selector or a paginated tool.",
  };
}

function boundMcpOutput(value: unknown, options: McpOutputOptions = {}): unknown {
  if (typeof value === "string") {
    return truncateMcpText(value, MCP_OUTPUT_MAX_BYTES).value;
  }
  if (Array.isArray(value)) {
    return boundMcpArray(value);
  }
  if (!isRecord(value)) {
    return value;
  }

  let output = { ...value };
  const resultLimit = boundedResultLimit(options.resultLimit);
  const markOutputTruncated = (): void => {
    output.mcpOutputTruncated = true;
  };
  const capArray = (key: string, limit: number, flag: string): void => {
    const items = output[key];
    if (Array.isArray(items) && items.length > limit) {
      const omitted = items.length - limit;
      output[key] = items.slice(0, limit);
      output[flag] = true;
      const omissionKey = `omitted${key.slice(0, 1).toUpperCase()}${key.slice(1)}`;
      const previousOmitted = typeof output[omissionKey] === "number" && Number.isSafeInteger(output[omissionKey])
        ? output[omissionKey] as number
        : 0;
      output[omissionKey] = previousOmitted + omitted;
      if (key === "results") {
        output.hasMore = true;
        if (typeof output.returnedResults === "number" && Number.isFinite(output.returnedResults)) {
          output.returnedResults = Math.min(Math.max(0, Math.trunc(output.returnedResults)), limit);
        }
        if (typeof output.warning !== "string") {
          output.warning = "Some search results were omitted by the MCP output limit; use a narrower request or a paginated tool.";
        }
      } else if (key === "entries") {
        output.hasMore = true;
        if (typeof output.returnedCount === "number" && Number.isFinite(output.returnedCount)) {
          output.returnedCount = Math.min(Math.max(0, Math.trunc(output.returnedCount)), limit);
        }
        const previousOmittedCount = typeof output.omittedCount === "number" && Number.isSafeInteger(output.omittedCount)
          ? Math.max(0, output.omittedCount as number)
          : 0;
        output.omittedCount = previousOmittedCount + omitted;
      }
      markOutputTruncated();
    }
  };
  const capText = (key: string, flag: string, maxBytes: number): void => {
    const text = output[key];
    if (typeof text !== "string") {
      return;
    }
    const bounded = truncateMcpText(text, maxBytes);
    if (bounded.truncated) {
      output[key] = bounded.value;
      output[flag] = true;
      markOutputTruncated();
    }
  };

  capText("text", "truncated", MCP_OUTPUT_TEXT_MAX_BYTES);
  capText("html", "truncated", MCP_OUTPUT_TEXT_MAX_BYTES);
  if (typeof output.text === "string" && output.textTruncated === undefined && output.hasMore === undefined && untrustedPayloadLength(output.text) >= MCP_PAGE_TEXT_MAX_CHARS) {
    output.truncated = true;
  }
  capArray("links", MCP_OUTPUT_LINK_LIMIT, "linksTruncated");
  if (!options.preserveBatchResults) {
    capArray("results", resultLimit, "resultsTruncated");
  }
  capArray("entries", MCP_OUTPUT_ENTRY_LIMIT, "entriesTruncated");
  capArray("interactive", MCP_OUTPUT_INTERACTIVE_LIMIT, "interactiveTruncated");
  capArray("nodes", MCP_OUTPUT_NODE_LIMIT, "nodesTruncated");
  capArray("matches", MCP_OUTPUT_MATCH_LIMIT, "matchesTruncated");
  capArray("frames", 20, "framesTruncated");
  for (const [key, item] of Object.entries(output)) {
    if (!MCP_OUTPUT_CONTRACT_ARRAY_KEYS.has(key) && Array.isArray(item)) {
      capArray(key, MCP_OUTPUT_ARRAY_ITEM_LIMIT, `${key}Truncated`);
    }
  }

  if (Array.isArray(output.results)) {
    output.results = output.results.map((item) => {
      if (!isRecord(item)) {
        return item;
      }
      const result = { ...item };
      if (typeof result.title === "string") {
        const boundedTitle = truncateMcpText(result.title, 1_000);
        if (boundedTitle.truncated) {
          result.title = boundedTitle.value;
          result.titleTruncated = true;
          markOutputTruncated();
        }
      }
      if (typeof result.snippet === "string") {
        const boundedSnippet = truncateMcpText(result.snippet, 4_000);
        if (boundedSnippet.truncated) {
          result.snippet = boundedSnippet.value;
          result.snippetTruncated = true;
          markOutputTruncated();
        }
      }
      return result;
    });
  }

  if (jsonByteLength(output) <= MCP_OUTPUT_MAX_BYTES) {
    return output;
  }

  if (options.preserveBatchResults && Array.isArray(output.results)) {
    const allResults = output.results;
    const base = { ...output };
    delete base.results;
    const retained: unknown[] = [];
    for (const item of allResults) {
      const candidate = { ...base, results: [...retained, item] };
      if (jsonByteLength(candidate) > MCP_OUTPUT_MAX_BYTES - 256) {
        break;
      }
      retained.push(item);
    }
    output = {
      ...base,
      results: retained,
      ...(retained.length < allResults.length ? { resultsTruncated: true, omittedResults: allResults.length - retained.length } : {}),
      ...(retained.length < allResults.length ? { mcpOutputTruncated: true } : {}),
    };
    if (jsonByteLength(output) <= MCP_OUTPUT_MAX_BYTES) {
      return output;
    }
  }

  const arrayBounds: ReadonlyArray<readonly [string, string]> = options.preserveBatchResults
    ? MCP_OUTPUT_ARRAY_BOUNDS
    : [...MCP_OUTPUT_ARRAY_BOUNDS, ["results", "resultsTruncated"]];
  for (const [key, flag] of arrayBounds) {
    while (jsonByteLength(output) > MCP_OUTPUT_MAX_BYTES && Array.isArray(output[key]) && output[key].length > 1) {
      const items = output[key] as unknown[];
      const nextLength = Math.max(1, Math.floor(items.length / 2));
      capArray(key, nextLength, flag);
    }
  }
  for (const key of ["text", "html"]) {
    while (jsonByteLength(output) > MCP_OUTPUT_MAX_BYTES && typeof output[key] === "string" && UTF8_ENCODER.encode(output[key] as string).byteLength > 4_000) {
      const current = output[key] as string;
      const nextLimit = Math.max(1_000, Math.floor(UTF8_ENCODER.encode(current).byteLength * 0.6));
      output[key] = truncateMcpText(current, nextLimit).value;
      output.truncated = true;
      markOutputTruncated();
    }
  }
  if (jsonByteLength(output) <= MCP_OUTPUT_MAX_BYTES) {
    return output;
  }

  const preserved: Record<string, unknown> = {};
  for (const key of ["pageId", "frameId", "snapshotId", "domRevision", "url", "untrustedUrl", "title", "selector", "query", "source", "offset", "nextOffset", "revision", "hasMore", "requestedMaxResults", "returnedResults", "textTruncated", "linksTruncated", "omittedLinks", "resultsTruncated", "omittedResults", "entriesTruncated", "omittedEntries", "interactiveTruncated", "omittedInteractive", "nodesTruncated", "omittedNodes", "matchesTruncated", "omittedMatches", "framesTruncated", "omittedFrames", "itemsTruncated", "omittedItems", "totalMatches", "warning"]) {
    const item = output[key];
    if (typeof item === "string") {
      preserved[key] = truncateUtf8(item, 1_000);
    } else if (typeof item === "number" || typeof item === "boolean" || item === null) {
      preserved[key] = item;
    }
  }
  return {
    ...preserved,
    truncated: true,
    mcpOutputTruncated: true,
    omittedFields: Object.keys(output).filter((key) => !(key in preserved)).slice(0, 50),
    warning: "The MCP result exceeded the client record budget; use a narrower selector or a paginated tool.",
  };
}

export function sanitizeMcpOutput(value: unknown, options: McpOutputOptions = {}): unknown {
  const bounded = boundMcpOutput(value, options);
  const redactedValue = redactValue(bounded);
  const redacted = isRecord(redactedValue) && redactedValue.__truncated === true && redactedValue.mcpOutputTruncated !== true
    ? { ...redactedValue, mcpOutputTruncated: true, warning: "The MCP result exceeded the safety collection limit; use a narrower request or a paginated tool." }
    : redactedValue;
  const redactedText = jsonText(redacted);
  if (Buffer.byteLength(redactedText, "utf8") <= MCP_OUTPUT_MAX_BYTES) {
    return redacted;
  }
  const finalValue = boundMcpOutput(redacted, options);
  jsonText(finalValue);
  return finalValue;
}

function boundedResultLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return MCP_OUTPUT_RESULT_LIMIT;
  }
  return Math.min(Math.max(Math.trunc(value), 1), MCP_OUTPUT_RESULT_LIMIT);
}

function safeToolResult(value: unknown): CallToolResult {
  const structuredContent = isRecord(value) ? value : { value };
  return {
    content: [{ type: "text", text: jsonText(value) }],
    structuredContent,
  };
}

export function jsonResource(uri: string, value: unknown): { contents: Array<{ uri: string; mimeType: string; text: string }> } {
  return { contents: [{ uri, mimeType: "application/json", text: jsonText(sanitizeMcpOutput(value)) }] };
}

export async function safeResourceRead<T>(operation: () => T | Promise<T>, runtime?: Pick<ServerRuntime, "logger">): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    runtime?.logger.warn("MCP resource operation failed", safeErrorDiagnostic(error));
    const normalized = error instanceof AppError
      ? error
      : new AppError("RESOURCE_READ_FAILED", "The requested MCP resource could not be read.", { status: 500, cause: error });
    throw new AppError(normalized.code, truncateMcpText(normalized.message, MCP_ERROR_MESSAGE_MAX_BYTES).value, {
      retryable: normalized.retryable,
      status: normalized.status,
      details: normalized.details ? sanitizeMcpOutput(normalized.details) as Record<string, unknown> : undefined,
      cause: error,
    });
  }
}

export async function callTool(operation: () => Promise<unknown>, logger?: Pick<ServerRuntime, "logger">, options: McpOutputOptions = {}): Promise<CallToolResult> {
  try {
    return safeToolResult(sanitizeMcpOutput(await operation(), options) ?? null);
  } catch (error) {
    try {
      logger?.logger.warn("MCP tool operation failed", safeErrorDiagnostic(error));
    } catch {
      // Diagnostics must never change the protocol response path.
    }
    return boundToolError(toolError(error));
  }
}

export async function callBatchTool(operation: () => Promise<unknown>, logger?: Pick<ServerRuntime, "logger">): Promise<CallToolResult> {
  try {
    return safeToolResult(sanitizeMcpOutput(await operation(), { preserveBatchResults: true }) ?? null);
  } catch (error) {
    logger?.logger.warn("MCP batch operation failed", safeErrorDiagnostic(error));
    return boundToolError(toolError(error));
  }
}

export async function callVisualTool(operation: () => Promise<unknown>, logger?: Pick<ServerRuntime, "logger">): Promise<CallToolResult> {
  try {
    const rawValue = await operation();
    if (isRecord(rawValue) && typeof rawValue.screenshotBase64 === "string") {
      const record = { ...rawValue };
      const screenshotBase64 = rawValue.screenshotBase64;
      delete record.screenshotBase64;
      if (estimateBase64Bytes(screenshotBase64) > MCP_IMAGE_MAX_BYTES) {
        throw new AppError("OUTPUT_TOO_LARGE", "The screenshot exceeded the MCP image output limit.");
      }
      const safeRecord = sanitizeMcpOutput(record);
      if (!isRecord(safeRecord)) {
        throw new AppError("INTERNAL_ERROR", "The MCP result could not be serialized safely.");
      }
      return {
        content: [
          { type: "text", text: jsonText(safeRecord) },
          { type: "image", data: screenshotBase64, mimeType: record.mimeType === "image/jpeg" ? "image/jpeg" : "image/png" },
        ],
        structuredContent: safeRecord,
      };
    }
    return safeToolResult(sanitizeMcpOutput(rawValue) ?? null);
  } catch (error) {
    logger?.logger.warn("MCP visual tool operation failed", safeErrorDiagnostic(error));
    return boundToolError(toolError(error));
  }
}

function estimateBase64Bytes(value: string): number {
  return Math.ceil(value.length * 3 / 4);
}

function boundToolError(result: CallToolResult): CallToolResult {
  if (!result.isError) {
    return result;
  }

  const structured = isRecord(result.structuredContent) ? result.structuredContent : {};
  const rawError = isRecord(structured.error) ? structured.error : {};
  const code = typeof rawError.code === "string"
    ? truncateUtf8(rawError.code, MCP_ERROR_CODE_MAX_BYTES)
    : "INTERNAL_ERROR";
  const rawMessage = typeof rawError.message === "string"
    ? rawError.message
    : "The MCP request failed.";
  const boundedMessage = truncateMcpText(rawMessage, MCP_ERROR_MESSAGE_MAX_BYTES);
  const error: Record<string, unknown> = {
    code,
    message: boundedMessage.value,
    retryable: rawError.retryable === true,
  };
  if (boundedMessage.truncated) {
    error.messageTruncated = true;
  }

  if (rawError.details !== undefined) {
    error.details = rawError.details;
  }

  const rawRecovery = isRecord(rawError.recovery) ? rawError.recovery : undefined;
  if (rawRecovery && typeof rawRecovery.tool === "string" && typeof rawRecovery.instruction === "string") {
    const recovery: Record<string, unknown> = {
      tool: truncateUtf8(rawRecovery.tool, 200),
      instruction: truncateMcpText(rawRecovery.instruction, 1_000).value,
    };
    if (isRecord(rawRecovery.arguments)) {
      const safeArguments = redactValue(rawRecovery.arguments);
      if (isRecord(safeArguments)) {
        const arguments_: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(safeArguments).slice(0, 8)) {
          if (typeof value === "string") {
            arguments_[truncateUtf8(key, 100)] = truncateUtf8(value, 200);
          } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
            arguments_[truncateUtf8(key, 100)] = value;
          }
        }
        if (Object.keys(arguments_).length > 0 && jsonByteLength(arguments_) <= 1_000) {
          recovery.arguments = arguments_;
        }
      }
    }
    error.recovery = recovery;
  }

  const payload = { ok: false, error };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}
