import type { ZodType } from "zod";

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

/**
 * Upper bound on how many `{` candidates {@link extractJson} will balanced-scan
 * before bailing to the last-open/last-close fallback.
 */
const MAX_CANDIDATES = 1000;

/**
 * Number of leading `{` candidates that {@link extractJson} will balanced-scan
 * before the cumulative scan budget is enforced.
 */
const BUDGET_BYPASS_CANDIDATES = 128;

/** Tagged-union result of a parse attempt. */
export type ParseResult<T> =
  | { ok: true; output: T; error?: string; raw: string }
  | { ok: false; output?: T; error: string; raw: string };

/** Structural subset of a ZodSafeParseError — enough to format the issues. */
interface ZodErrorLike {
  issues: Array<{ path: PropertyKey[]; message: string }>;
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

/**
 * Strip markdown fences and isolate the JSON object from surrounding prose.
 * Strategy:
 * 1. Strip ```json…``` or ```…``` fences (opening *and* closing) if present.
 * 2. Candidate search: collect every `{` position, ordered FIRST-to-last.
 * 3. Balanced-brace extraction: from a candidate `{`, track depth honoring
 * string literals + escape sequences until the matching `}` closes the
 * top-level object. The first candidate whose scan closes cleanly wins.
 * 4. Fallback: if no `{` yields a balanced object, slice the last `{` to the
 * last `}` so the subsequent `JSON.parse` surfaces a useful syntax error
 * instead of throwing on surrounding prose.
 */
export function extractJson(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("```")) {
    s = s
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```(?:json)?\s*$/i, "")
      .trim();
  }

  const candidates: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "{") candidates.push(i);
  }
  if (candidates.length === 0) return s;

  let checked = 0;
  let scanned = 0;
  const SCAN_BUDGET = MAX_JSON_LENGTH * 4;
  const spans: Array<[number, number]> = [];
  for (const start of candidates) {
    if (checked >= MAX_CANDIDATES) break;
    const span = s.length - start;
    if (checked >= BUDGET_BYPASS_CANDIDATES && scanned + span > SCAN_BUDGET) break;
    scanned += span;
    checked++;
    const end = balancedEnd(s, start);
    if (end !== -1) spans.push([start, end]);
  }

  let bestValid: [number, number] | null = null;
  let bestValidLen = -1;
  for (const [start, end] of spans) {
    const candidate = s.slice(start, end + 1);
    try {
      JSON.parse(candidate);
      const len = end - start;
      if (len > bestValidLen) {
        bestValidLen = len;
        bestValid = [start, end];
      }
    } catch {
      // Not valid JSON — keep looking for a larger valid span.
    }
  }
  if (bestValid) return s.slice(bestValid[0], bestValid[1] + 1);
  if (spans.length > 0) {
    let best = spans[0];
    for (const span of spans) {
      if (span[1] - span[0] > best[1] - best[0]) best = span;
    }
    return s.slice(best[0], best[1] + 1);
  }

  const lastOpen = s.lastIndexOf("{");
  const lastClose = s.lastIndexOf("}");
  if (lastOpen !== -1 && lastClose !== -1 && lastClose > lastOpen) {
    return s.slice(lastOpen, lastClose + 1);
  }
  return s;
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
 * Reject an over-budget raw payload BEFORE any O(n) brace scanning.
 * Returns the error result when over budget, or `null` to proceed.
 */
function guardRawLength(
  raw: string,
): { ok: false; error: string; raw: string } | null {
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
function jsonError(
  raw: string,
  jsonStr: string,
  e: unknown,
): { ok: false; error: string; raw: string } {
  const message = e instanceof Error ? e.message : String(e);
  return {
    ok: false,
    error: `JSON parse error: ${message}. Snippet: ${jsonStr.slice(0, ERROR_SNIPPET_LENGTH)}`,
    raw,
  };
}

/**
 * Decode an extracted JSON string into `unknown`, guarding against a payload
 * that exceeds {@link MAX_JSON_LENGTH}.
 */
function decodeJson(
  raw: string,
  jsonStr: string,
): { ok: false; error: string; raw: string } | { ok: true; parsed: unknown } {
  try {
    return { ok: true, parsed: JSON.parse(jsonStr) };
  } catch (e) {
    return jsonError(raw, jsonStr, e);
  }
}

/**
 * Generic parser shared by parseAgentOutput / parsePlannerOutput.
 * Guards the raw length, decodes + extracts the JSON, then validates against the
 * given schema — returning the same ParseResult shape for both.
 */
export function parseOutput<T>(schema: ZodType<T>, raw: string): ParseResult<T> {
  const oversize = guardRawLength(raw);
  if (oversize) return oversize;
  const decoded = decodeJson(raw, extractJson(raw));
  if (!decoded.ok) return decoded;
  const result = schema.safeParse(decoded.parsed);
  if (result.success) {
    return { ok: true, output: result.data, raw };
  }
  return {
    ok: false,
    error: `Schema validation error: ${formatZodError(result.error)}`,
    raw,
  };
}
