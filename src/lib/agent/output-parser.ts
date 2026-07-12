/**
 * Output parser — validates LLM JSON responses against Zod schemas.
 *
 * Replaces fragile string-slicing (which broke on JSON containing `}`) with
 * a tolerant extractor + Zod validation. On validation failure, returns a
 * structured error so the loop can retry with a "your last response was
 * invalid JSON" nudge.
 */

import { AgentOutputSchema, PlannerOutputSchema } from "./tools/schema";
import type { AgentOutput, PlannerOutput } from "./types";

/** Maximum characters of the raw payload to include in error messages. */
const ERROR_SNIPPET_LENGTH = 200;

/** Maximum number of Zod issues to include in the error message. */
const MAX_ZOD_ISSUES = 5;

/**
 * Maximum characters of extracted JSON we will attempt to `JSON.parse` + Zod
 * validate. A hostile or malformed page can trick the model into emitting a
 * huge blob; rejecting early (before parse/validation) is cheaper and fails
 * fast with a clear error instead of stalling on a multi-megabyte payload.
 */
const MAX_JSON_LENGTH = 1_000_000;

/** Tagged-union result of a parse attempt. */
export interface ParseResult<T> {
  /** Whether parsing + validation succeeded. */
  ok: boolean;
  /** The validated output (only present when `ok` is true). */
  output?: T;
  /** Human-readable error message (only present when `ok` is false). */
  error?: string;
  /** The original raw text, always present (for debugging / streaming). */
  raw: string;
}

/**
 * Strip markdown fences and isolate the JSON object from surrounding prose.
 * Strategy:
 * 1. Strip ```json…``` or ```…``` fences (opening *and* closing) if present.
 * 2. Candidate search: collect every `{` position, ordered FIRST-to-last.
 * We return the FIRST candidate whose balanced scan closes cleanly — that
 * is the intended payload for well-formed LLM output, and it correctly
 * handles nested objects (the outermost `{` is the first one scanned, so
 * the matching `}` is the final closing brace, capturing the whole nested
 * structure rather than an inner fragment).
 * 3. Balanced-brace extraction: from a candidate `{`, track depth honoring
 * string literals + escape sequences until the matching `}` closes the
 * top-level object. The first candidate whose scan closes cleanly wins.
 * This correctly handles JSON payloads that contain `}` characters inside
 * string values (where a naive first/last brace slice would over-slice).
 * 4. Fallback: if no `{` yields a balanced object, slice the last `{` to the
 * last `}` so the subsequent `JSON.parse` surfaces a useful syntax error
 * instead of throwing on surrounding prose.
 *
 * Limitation: only a single top-level JSON object is returned (the first
 * complete one found). Callers needing different behavior should pre-trim the
 * input.
 */
export function extractJson(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("```")) {
 // Strip an optional opening ``` or ```json fence, then an optional closing
 // ``` or ```json fence. The closing variant MUST also accept the `json`
 // language tag, otherwise the trailing "json" leaks into the output and
 // breaks the parse.
    s = s
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```(?:json)?\s*$/i, "")
      .trim();
  }

 // Collect every `{` position, ordered first-to-last. The genuine payload is
 // the FIRST complete object, and scanning outermost-first preserves nested
 // objects in full.
  const candidates: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "{") candidates.push(i);
  }
  if (candidates.length === 0) return s;

  for (const start of candidates) {
    const end = balancedEnd(s, start);
    if (end !== -1) return s.slice(start, end + 1);
  }

 // Fallback: unbalanced input — slice last `{` to last `}` so JSON.parse
 // surfaces a syntax error rather than choking on trailing prose.
  const lastOpen = s.lastIndexOf("{");
  const lastClose = s.lastIndexOf("}");
  if (lastOpen !== -1 && lastClose !== -1 && lastClose > lastOpen) {
    return s.slice(lastOpen, lastClose + 1);
  }
  return s;
}

/**
 * Given `s` and the index of an opening `{` at `start`, return the index of the
 * matching top-level `}` (inclusive) or `-1` if the scan never returns to depth
 * 0 (unbalanced input). String literals and escape sequences are honored so
 * braces inside string values do not perturb the depth count.
 */
function balancedEnd(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/** Structural subset of a ZodSafeParseError — enough to format the issues. */
interface ZodErrorLike {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}

/**
 * Format a Zod error into a single-line, human-readable string.
 * Truncates to the first {@link MAX_ZOD_ISSUES} issues to keep prompts bounded.
 */
function formatZodError(error: ZodErrorLike): string {
  return error.issues
    .slice(0, MAX_ZOD_ISSUES)
    .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

/**
 * Reject an over-budget raw payload BEFORE any O(n) brace scanning. `extractJson`
 * walks every `{` candidate to the end of the string, so an adversarial input
 * (e.g. a megabyte of `{`) would otherwise incur ~O(n²) work before the
 * post-extraction budget check inside {@link decodeJson} ever fires. Guarding on
 * `raw.length` up front keeps the fast-fail promise the module documents.
 * Returns the error result when over budget, or `null` to proceed.
 */
function guardRawLength(raw: string): { ok: false; error: string; raw: string } | null {
  if (raw.length > MAX_JSON_LENGTH) {
    return {
      ok: false,
      error: `Raw response is ${raw.length} characters — exceeds the ${MAX_JSON_LENGTH}-character budget.`,
      raw,
    };
  }
  return null;
}

/** Build a ParseResult for a JSON.parse failure. */
function jsonError(raw: string, jsonStr: string, e: unknown): { ok: false; error: string; raw: string } {
  const message = e instanceof Error ? e.message : String(e);
  return {
    ok: false,
    error: `JSON parse error: ${message}. Snippet: ${jsonStr.slice(0, ERROR_SNIPPET_LENGTH)}`,
    raw,
  };
}

/**
 * Decode an extracted JSON string into `unknown`, guarding against a payload
 * that exceeds {@link MAX_JSON_LENGTH} so we fail cheaply before Zod validation.
 * Returns a discriminated union — the `ok: false` variant carries `error` while
 * the `ok: true` variant carries `parsed` — so callers can narrow on `ok` and
 * access `parsed` without a type error.
 */
function decodeJson(
  raw: string,
  jsonStr: string,
): { ok: false; error: string; raw: string } | { ok: true; parsed: unknown } {
  if (jsonStr.length > MAX_JSON_LENGTH) {
    return {
      ok: false,
      error: `Extracted JSON is ${jsonStr.length} characters — exceeds the ${MAX_JSON_LENGTH}-character budget.`,
      raw,
    };
  }
  try {
    return { ok: true, parsed: JSON.parse(jsonStr) };
  } catch (e) {
    return jsonError(raw, jsonStr, e);
  }
}

/**
 * Parse a raw navigator LLM response into a validated {@link AgentOutput}.
 * Returns `{ ok: false, error }` on JSON, budget, or schema failure.
 */
export function parseAgentOutput(raw: string): ParseResult<AgentOutput> {
  const oversize = guardRawLength(raw);
  if (oversize) return oversize;
  const decoded = decodeJson(raw, extractJson(raw));
  if (!decoded.ok) return decoded;
  const result = AgentOutputSchema.safeParse(decoded.parsed);
  if (result.success) {
    return { ok: true, output: result.data as AgentOutput, raw };
  }
  return {
    ok: false,
    error: `Schema validation error: ${formatZodError(result.error)}`,
    raw,
  };
}

/**
 * Parse a raw planner LLM response into a validated {@link PlannerOutput}.
 * Returns `{ ok: false, error }` on JSON, budget, or schema failure.
 */
export function parsePlannerOutput(raw: string): ParseResult<PlannerOutput> {
  const oversize = guardRawLength(raw);
  if (oversize) return oversize;
  const decoded = decodeJson(raw, extractJson(raw));
  if (!decoded.ok) return decoded;
  const result = PlannerOutputSchema.safeParse(decoded.parsed);
  if (result.success) {
    return { ok: true, output: result.data as PlannerOutput, raw };
  }
  return {
    ok: false,
    error: `Schema validation error: ${formatZodError(result.error)}`,
    raw,
  };
}
