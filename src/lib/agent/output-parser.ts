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
 *   1. Strip ```json…``` or ```…``` fences if present.
 *   2. Balanced-brace extraction: scan from the first `{`, tracking depth,
 *      honoring string literals + escape sequences, until the matching `}`
 *      closes the top-level object. This handles JSON payloads that contain
 *      `}` characters inside string values (where the previous first/last
 *      brace heuristic would over-slice).
 *   3. If balanced extraction fails (no `{` or unbalanced input), fall back
 *      to the first-`{`-to-last-`}` slice so the subsequent `JSON.parse`
 *      surfaces a useful syntax error instead of throwing on surrounding prose.
 *
 * Limitation: balanced extraction is character-by-character and assumes the
 * first `{` opens the intended object. LLM responses that include multiple
 * top-level JSON objects will return only the first. Callers that need a
 * different behavior should pre-trim the input.
 */
export function extractJson(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  }
  const start = s.indexOf("{");
  if (start === -1) return s;

  // Balanced-brace scan: track depth, skip string literals + escapes.
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
        return s.slice(start, i + 1);
      }
    }
  }

  // Fallback: unbalanced input — slice first `{` to last `}` so JSON.parse
  // surfaces a syntax error rather than choking on trailing prose.
  const last = s.lastIndexOf("}");
  if (last !== -1 && last > start) {
    return s.slice(start, last + 1);
  }
  return s;
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

/** Build a ParseResult for a JSON.parse failure. */
function jsonError(raw: string, jsonStr: string, e: unknown): ParseResult<never> {
  const message = e instanceof Error ? e.message : String(e);
  return {
    ok: false,
    error: `JSON parse error: ${message}. Snippet: ${jsonStr.slice(0, ERROR_SNIPPET_LENGTH)}`,
    raw,
  };
}

/**
 * Parse a raw navigator LLM response into a validated {@link AgentOutput}.
 * Returns `{ ok: false, error }` on JSON or schema failure.
 */
export function parseAgentOutput(raw: string): ParseResult<AgentOutput> {
  const jsonStr = extractJson(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    return jsonError(raw, jsonStr, e);
  }
  const result = AgentOutputSchema.safeParse(parsed);
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
 * Returns `{ ok: false, error }` on JSON or schema failure.
 */
export function parsePlannerOutput(raw: string): ParseResult<PlannerOutput> {
  const jsonStr = extractJson(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    return jsonError(raw, jsonStr, e);
  }
  const result = PlannerOutputSchema.safeParse(parsed);
  if (result.success) {
    return { ok: true, output: result.data as PlannerOutput, raw };
  }
  return {
    ok: false,
    error: `Schema validation error: ${formatZodError(result.error)}`,
    raw,
  };
}
