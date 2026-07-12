/**
 * Tool registry — format-instruction helpers + user-defined custom tools.
 *
 * The agent's action dispatch is the hardcoded 32-handler switch in
 * `./executor.ts`. This module owns the two pieces of tool-related
 * infrastructure that production code needs on top of that switch:
 *
 * 1. `getFormatInstructions(schema)` — render a Zod schema as a
 * prompt-injectable JSON-schema description (used by providers that
 * don't accept a native JSON schema: Ollama, local, OpenAI JSON mode).
 *
 * 2. Custom tools (`CustomTool`, `loadCustomTools`,
 * `formatCustomToolsBlock`, `substituteCustomToolCalls`) — user-defined
 * JavaScript snippets the agent invokes via the `evaluate` action with
 * `__opencowork_custom_tool('<name>')`. Stored verbatim in
 * `chrome.storage.local`; substituted at execute time.
 */

import { z } from "zod";
import type { ZodType } from "zod";

import { isExtensionWithLocal } from "../runtime";

// ─── Format instructions (for non-structured-output providers) ───────────────
//
// Some providers (Ollama, local, OpenAI JSON mode) don't accept a native JSON
// schema — they need the schema inlined as text in the system prompt so the
// model knows what shape to emit. `getFormatInstructions` produces that text
// from any Zod schema, using Zod 4's native `z.toJSONSchema(...)` (no external
// dependency required).

/** The format-instructions preamble (kept short to minimise prompt tokens). */
const FORMAT_INSTRUCTIONS_PREAMBLE =
  "The output should be formatted as a JSON instance that conforms to the JSON schema below.\n\nHere is the output schema:\n```";

/**
 * Generate prompt-injectable format instructions for a Zod schema.
 *
 * Uses Zod 4's native `z.toJSONSchema(...)` (no external dependency). Strips
 * the redundant top-level `$schema` key to keep the prompt compact.
 *
 * @example
 * const text = getFormatInstructions(AgentOutputSchema);
 * // → "The output should be formatted as a JSON instance that conforms to the JSON schema below.\n\nHere is the output schema:\n```json\n{...}\n```"
 *
 * @param schema Any Zod schema (object, discriminated union, etc.).
 * @returns A string ready to append to a system prompt.
 */
// Cache by schema reference — the output is constant for a given schema.
const formatInstructionsCache = new WeakMap<ZodType, string>();

export function getFormatInstructions(schema: ZodType): string {
  const cached = formatInstructionsCache.get(schema);
  if (cached !== undefined) return cached;
 // Zod 4 exposes `z.toJSONSchema(schema)` (and a per-schema `.toJSONSchema()`
 // method) — we fall back to a hand-rolled minimal shape if either is
 // missing (older Zod versions / edge cases) so the function is total.
  let jsonSchema: Record<string, unknown> | null = null;
  try {
    const zNS = (z as unknown as { toJSONSchema?: (s: ZodType) => Record<string, unknown> });
    if (typeof zNS.toJSONSchema === "function") {
      jsonSchema = zNS.toJSONSchema(schema);
    }
  } catch {
    jsonSchema = null;
  }
  if (!jsonSchema) {
    try {
      const perSchema = (schema as unknown as { toJSONSchema?: () => Record<string, unknown> });
      if (typeof perSchema.toJSONSchema === "function") {
        jsonSchema = perSchema.toJSONSchema();
      }
    } catch {
      jsonSchema = null;
    }
  }
  if (!jsonSchema) {
 // Last-resort minimal shape so callers always get a string. Emit a warning
 // so the degradation is observable rather than silent: a model that relies
 // on these prompt-injected instructions (Ollama, local, OpenAI JSON mode)
 // would otherwise receive an effectively empty schema with zero field
 // information and could emit malformed output (FULL-REVIEW finding 13 / 54
 // / 141).
    console.warn(
      "[registry] getFormatInstructions: z.toJSONSchema unavailable; falling back to {type:\"object\"} (no field schema emitted)."
    );
    jsonSchema = { type: "object" };
  }
 // Strip the redundant `$schema` key — it's the JSON-Schema dialect URL, not
 // a property the model needs to emit. Keeps the prompt lean.
  if (jsonSchema && typeof jsonSchema === "object" && "$schema" in jsonSchema) {
    const { $schema: _drop, ...rest } = jsonSchema;
    jsonSchema = rest;
  }
  const result = `${FORMAT_INSTRUCTIONS_PREAMBLE}json\n${JSON.stringify(jsonSchema)}\n\`\`\``;
  formatInstructionsCache.set(schema, result);
  return result;
}

// ─── Custom tools (user-defined JS snippets) ──────────────────────────────────

/**
 * A user-defined custom tool. Stored verbatim in `chrome.storage.local`; the
 * agent invokes them via the existing `evaluate` action with the snippet
 * wrapped in `__opencowork_custom_tool('<name>')`.
 *
 * Custom tools are NOT registered as Zod action types (that would require
 * modifying `tools/schema.ts`, owned by another agent). Instead:
 * 1. The navigator prompt lists them in a `<custom_tools>` block (built by
 * {@link formatCustomToolsBlock}).
 * 2. The `evaluate` action runs them via {@link substituteCustomToolCalls}
 * (called by the executor, owned by another agent — wiring documented in
 * the sidepanel and background modules).
 *
 * TRUST BOUNDARY: `code` is arbitrary JavaScript executed on the page's
 * `window`/`document` via the `evaluate` action. The storage backing it
 * (`chrome.storage.local`, or `localStorage` on the demo page) can be written
 * by any extension context or a stored-XSS in the options page, so a custom
 * tool is effectively an explicit, user-opt-in RCE primitive. This module only
 * validates the *shape* of a tool on load (see {@link isValidCustomTool}); it
 * does not sandbox execution. Runtime confirmation of first use is the
 * executor's responsibility (owned by another agent).
 */
export interface CustomTool {
  /** Unique tool name (matches the regex below — used as a key). */
  name: string;
  /** One-sentence description shown in the navigator prompt. */
  description: string;
  /** JavaScript source — evaluated with the page's `window`/`document` in scope. */
  code: string;
  /** Unix ms timestamp when this tool was created (set by the options page). */
  createdAt?: number;
}

/** Storage key under which the custom-tools array is persisted. */
export const CUSTOM_TOOLS_STORAGE_KEY = "__opencowork_custom_tools";

/**
 * Name validation regex — allows lowercase letters, digits, underscores.
 * Keeps the name safe to embed in `__opencowork_custom_tool('<name>')` without
 * escaping concerns, and matches typical `snake_case` tool names.
 */
export const CUSTOM_TOOL_NAME_REGEX = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Maximum length (in characters) of a custom tool's `code`. Bound to keep the
 * `evaluate` payload from ballooning — the `$` escaping plus the up-to-3-pass
 * substitution can expand it further, and an oversized/oddly-nested tool risks
 * hitting `LIMITS.evaluateTimeoutMs` for otherwise-benign tools. Tools exceeding
 * this are dropped on load (see {@link isValidCustomTool}).
 */
export const MAX_CUSTOM_TOOL_CODE_LENGTH = 256 * 1024;

/** Maximum rendered length of a tool description in the `<custom_tools>` block. */
const MAX_TOOL_DESCRIPTION_LENGTH = 200;

/**
 * Maximum *stored* length of a custom-tool `description`. Bounds the payload
 * that ends up in `chrome.storage.local` and in the prompt block; a tool whose
 * description exceeds this is dropped on load (see {@link isValidCustomTool}).
 * Kept generous so legitimate multi-sentence descriptions survive, while still
 * protecting the storage write + prompt size (FULL-REVIEW finding 109).
 */
export const MAX_CUSTOM_TOOL_DESCRIPTION_LENGTH = 2000;

/**
 * Type guard + validator for a persisted custom-tool entry.
 *
 * Guarantees `name` matches the safe name regex and that `code`/`description`
 * are real strings of bounded length, so downstream prompt formatting and
 * substitution never receive `undefined`/non-string values from a hand-edited
 * or corrupted storage entry.
 *
 * NOTE — trust boundary: this validates *shape*, not *safety*. Custom-tool
 * `code` is arbitrary JavaScript executed on the page; this guard does not
 * sandbox it (see {@link CustomTool}).
 */
export function isValidCustomTool(value: unknown): value is CustomTool {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  if (typeof t.name !== "string" || !CUSTOM_TOOL_NAME_REGEX.test(t.name)) return false;
  if (typeof t.description !== "string" || t.description.length > MAX_CUSTOM_TOOL_DESCRIPTION_LENGTH) {
    return false;
  }
  if (typeof t.code !== "string" || t.code.length > MAX_CUSTOM_TOOL_CODE_LENGTH) return false;
  return true;
}

/**
 * Sanitize a tool description before inlining it into the `<custom_tools>`
 * prompt block. The description is untrusted (user-authored, persisted in
 * `chrome.storage.local`) yet placed inside the trusted system prompt, so we:
 * 1. collapse all whitespace (incl. newlines) — stops a description breaking
 * onto a new prompt line or spoofing block structure;
 * 2. strip angle brackets — a `</custom_tools>` could otherwise close the
 * block early;
 * 3. cap length so a huge description can't pad the prompt.
 */
function sanitizeToolDescription(description: string): string {
  const collapsed = description.replace(/\s+/g, " ").trim();
  const stripped = collapsed.replace(/[<>]/g, "");
  if (stripped.length > MAX_TOOL_DESCRIPTION_LENGTH) {
    return stripped.slice(0, MAX_TOOL_DESCRIPTION_LENGTH).trimEnd() + "…";
  }
  return stripped;
}

/**
 * Surface a swallowed storage/parse error on a debug channel. We deliberately
 * do NOT cache the empty result on error — `loadCustomTools` returns `[]`
 * without assigning `customToolsCache`, so the next call retries rather than
 * hiding all custom tools for the rest of the session.
 */
function logLoadError(source: string, err: unknown): void {
 // Surface the failure (not just swallow it) so a dropped/malformed
 // custom-tools payload is diagnosable instead of silently vanishing
 // (FULL-REVIEW finding 138 / 142). `console.warn` keeps it visible without
 // being as noisy as `error`.
  if (typeof console !== "undefined" && typeof console.warn === "function") {
    console.warn(`[custom-tools] failed to load tools from ${source}:`, err);
  }
}

/**
 * Load all custom tools from storage.
 *
 * Returns an empty array on any storage / parse error so callers can safely
 * iterate without try/catch.
 */
// Module-level cache for custom tools. `formatCustomToolsBlock` is called on
// every navigator step; without caching, each step does a fresh
// chrome.storage.local round-trip for data that's effectively static for the
// run's duration. The cache is invalidated by `chrome.storage.onChanged`.
let customToolsCache: CustomTool[] | null = null;

function invalidateCustomToolsCache(): void {
  customToolsCache = null;
}

// Register the onChanged listener once (idempotent).
if (isExtensionWithLocal() && typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[CUSTOM_TOOLS_STORAGE_KEY]) {
      invalidateCustomToolsCache();
    }
  });
}

export async function loadCustomTools(): Promise<CustomTool[]> {
  if (customToolsCache !== null) return customToolsCache;
  if (isExtensionWithLocal()) {
    try {
      const res = await chrome.storage.local.get(CUSTOM_TOOLS_STORAGE_KEY);
      const raw = res[CUSTOM_TOOLS_STORAGE_KEY];
 // A corrupted / injected payload could hold a non-array (e.g. a string or
 // number). Casting and calling `.filter` on a non-array would throw a
 // TypeError and drop ALL tools silently. Assert the shape first and
 // surface the anomaly (FULL-REVIEW finding 14).
      if (!Array.isArray(raw)) {
        if (raw !== undefined) {
          logLoadError(
            "chrome.storage.local",
            new Error(`expected an array of custom tools, got ${typeof raw}`)
          );
        }
        return [];
      }
 // Keep only well-formed tools: valid name, string code/description, and a
 // bounded code + description length (defensive — hand-edited or corrupted
 // storage entries could otherwise smuggle a bad name or inject undefined
 // values).
      customToolsCache = raw.filter(isValidCustomTool);
      return customToolsCache;
    } catch (err) {
      logLoadError("chrome.storage.local", err);
      return [];
    }
  }
 // Fallback to localStorage (demo page / Next.js preview).
  try {
    const raw = localStorage.getItem(CUSTOM_TOOLS_STORAGE_KEY);
    const tools = raw ? (JSON.parse(raw) as CustomTool[]) : [];
    customToolsCache = tools.filter(isValidCustomTool);
    return customToolsCache;
  } catch (err) {
    logLoadError("localStorage", err);
    return [];
  }
}

/**
 * Format the custom-tools list as a `<custom_tools>` prompt block.
 *
 * Returns an empty string when there are no custom tools (so the navigator
 * message builder pays zero token overhead on default installs).
 *
 * The block tells the LLM the names + descriptions of the available custom
 * tools and how to invoke them via the existing `evaluate` action:
 *
 * ```
 * <custom_tools>
 * The following custom JavaScript tools are available. Use `evaluate` with
 * the exact expression `__opencowork_custom_tool('<name>')` to invoke one —
 * the runtime will substitute the stored code before execution.
 * - scrape_table: Scrape a table from the page
 * - count_links: Count the <a> tags on the page
 * </custom_tools>
 * ```
 *
 * NOTE: the stored tool code is intentionally NOT inlined into the prompt —
 * the LLM doesn't need to see the implementation, only know that the tool
 * exists. The code is substituted at execute time by the `evaluate` handler.
 */
export async function formatCustomToolsBlock(): Promise<string> {
  const tools = await loadCustomTools();
  if (tools.length === 0) return "";
 // Sanitize each description — it's untrusted input placed in the trusted
 // system prompt (see {@link sanitizeToolDescription}).
  const lines = tools.map((t) => `- ${t.name}: ${sanitizeToolDescription(t.description)}`);
  return (
    "<custom_tools>\n" +
    "The following custom JavaScript tools are available. Use `evaluate` with " +
    "the exact expression `__opencowork_custom_tool('<name>')` to invoke one — " +
    "the runtime will substitute the stored code before execution.\n" +
    lines.join("\n") +
    "\n</custom_tools>"
  );
}

/**
 * Match `__opencowork_custom_tool('<name>')` / `__opencowork_custom_tool("<name>")`
 * calls in an evaluate payload. Used internally by {@link substituteCustomToolCalls}.
 */
const CUSTOM_TOOL_CALL_REGEX = /__opencowork_custom_tool\(\s*['"]([a-z][a-z0-9_]{0,63})['"]\s*\)/g;

/**
 * Replace every `__opencowork_custom_tool('<name>')` call in `code` with the
 * stored source for that tool. Unknown tool names are left untouched (the
 * page-side `evaluate` will throw a clean ReferenceError — better than silently
 * dropping the call).
 *
 * Exported so tests + the executor can use the same substitution path.
 */
export async function substituteCustomToolCalls(
  code: string,
): Promise<string> {
  const tools = await loadCustomTools();
  if (tools.length === 0) return code;
  const byName = new Map(tools.map((t) => [t.name, t.code] as const));
  let result = code;
  let changed = true;
 // Run substitution until stable (handles nested calls in the same code) —
 // bounded to 3 passes so a self-referential tool can't blow up the result
 // exponentially.
  let passes = 0;
  while (changed && passes < 3) {
    changed = false;
    passes++;
    result = result.replace(CUSTOM_TOOL_CALL_REGEX, (full, name: string) => {
      const sub = byName.get(name);
      if (sub === undefined) return full; // unknown tool — leave for the page.
      changed = true;
 // Wrap in an IIFE if the body has statement keywords OR a semicolon
 // (multi-statement or trailing-semicolon expression). Bare expressions
 // (e.g. `document.title`) are parenthesized so their value is returned.
 // A trailing semicolon (`document.title;`) also triggers IIFE wrapping
 // because `(document.title;)` is a SyntaxError — the IIFE form
 // `(()=>{document.title;})()` is valid (returns undefined, but that's
 // better than crashing).
      const needsIife = /\breturn\b/.test(sub) || /\b(const|let|var|if|for|while|throw|do|switch|try|function|class)\b/.test(sub) || /;/.test(sub);
 // Escape `$` before returning: a function replacer's return value is
 // re-parsed as a replacement string, so any `$&`/`$``/`$'`/`$n`/`$$`
 // sequence inside the user's tool code would be silently reinterpreted.
 // Doubling each `$` (`$` → `$$`) neutralises that interpretation, because
 // the re-parse turns `$$` back into a single `$` (this correctly preserves
 // literal `$1`, `$&`, `$'` etc. that appear in the tool code).
      const escapedSub = sub.replace(/\$/g, "$$");
 // Guard against a trailing single-line `// comment` in the tool body:
 // without a trailing newline, the closing `)` / `})()` would land on the
 // same line and be swallowed by the comment, producing a SyntaxError when
 // the page evals the result. Appending a newline ends any line comment
 // first. (Block comments `/* */` are unaffected.)
      const body = escapedSub.endsWith("\n") ? escapedSub : escapedSub + "\n";
      return needsIife ? `(()=>{${body}})()` : `(${body})`;
    });
  }
  return result;
}
