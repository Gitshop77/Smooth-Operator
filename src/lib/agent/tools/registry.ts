/**
 * Tool registry — format-instruction helpers + user-defined custom tools.
 *
 * The agent's action dispatch is the hardcoded 32-handler switch in
 * `./executor.ts`. This module owns the two pieces of tool-related
 * infrastructure that production code needs on top of that switch:
 *
 *   1. `getFormatInstructions(schema)` — render a Zod schema as a
 *      prompt-injectable JSON-schema description (used by providers that
 *      don't accept a native JSON schema: Ollama, local, OpenAI JSON mode).
 *
 *   2. Custom tools (`CustomTool`, `loadCustomTools`,
 *      `formatCustomToolsBlock`, `substituteCustomToolCalls`) — user-defined
 *      JavaScript snippets the agent invokes via the `evaluate` action with
 *      `__opencowork_custom_tool('<name>')`. Stored verbatim in
 *      `chrome.storage.local`; substituted at execute time.
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
 * @returns      A string ready to append to a system prompt.
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
    // Last-resort minimal shape so callers always get a string.
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
 *   1. The navigator prompt lists them in a `<custom_tools>` block (built by
 *      {@link formatCustomToolsBlock}).
 *   2. The `evaluate` action runs them via {@link substituteCustomToolCalls}
 *      (called by the executor, owned by another agent — wiring documented in
 *      the sidepanel and background modules).
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
      const tools = (res[CUSTOM_TOOLS_STORAGE_KEY] as CustomTool[] | undefined) || [];
      // Filter out any tools that don't pass the name regex (defensive — a
      // hand-edited storage entry could otherwise smuggle a bad name).
      customToolsCache = tools.filter((t) => CUSTOM_TOOL_NAME_REGEX.test(t.name));
      return customToolsCache;
    } catch {
      return [];
    }
  }
  // Fallback to localStorage (demo page / Next.js preview).
  try {
    const raw = localStorage.getItem(CUSTOM_TOOLS_STORAGE_KEY);
    const tools = raw ? (JSON.parse(raw) as CustomTool[]) : [];
    customToolsCache = tools.filter((t) => CUSTOM_TOOL_NAME_REGEX.test(t.name));
    return customToolsCache;
  } catch {
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
  const lines = tools.map((t) => `- ${t.name}: ${t.description}`);
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
      return needsIife ? `(()=>{${sub}})()` : `(${sub})`;
    });
  }
  return result;
}
