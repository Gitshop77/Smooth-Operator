/**
 * Helper functions for the tool registry.
 *
 * Split from `registry.ts` to separate logic from orchestration.
 */

import { z } from "zod";
import type { ZodType } from "zod";

import { isExtensionWithLocal } from "../runtime";
import { sanitizeUntrusted } from "../security";

import {
  type CustomTool,
  CUSTOM_TOOLS_STORAGE_KEY,
  CUSTOM_TOOL_NAME_REGEX,
  FORMAT_INSTRUCTIONS_PREAMBLE,
  MAX_CUSTOM_TOOL_CODE_LENGTH,
  MAX_CUSTOM_TOOL_DESCRIPTION_LENGTH,
  MAX_CUSTOM_TOOLS_BLOCK,
  MAX_SUBSTITUTION_RESULT_LENGTH,
  RENDERED_TOOL_DESCRIPTION_LENGTH,
} from "./registry-data";

// ─── Format instructions ─────────────────────────────────────────────────────

/** Cache for `getFormatInstructions` — keyed by schema reference. */
const formatInstructionsCache = new WeakMap<ZodType, string>();

/**
 * Generate prompt-injectable format instructions for a Zod schema.
 *
 * Uses Zod 4's native `z.toJSONSchema(...)` (no external dependency). Strips
 * the redundant top-level `$schema` key to keep the prompt compact.
 */
export function getFormatInstructions(schema: ZodType): string {
  const cached = formatInstructionsCache.get(schema);
  if (cached !== undefined) return cached;

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
    console.warn(
      "[registry] getFormatInstructions: z.toJSONSchema unavailable; falling back to {type:\"object\"} (no field schema emitted)."
    );
    jsonSchema = { type: "object" };
  }
  if (jsonSchema && typeof jsonSchema === "object" && "$schema" in jsonSchema) {
    const { $schema: _drop, ...rest } = jsonSchema;
    jsonSchema = rest;
  }
  const result = `${FORMAT_INSTRUCTIONS_PREAMBLE}json\n${JSON.stringify(jsonSchema)}\n\`\`\``;
  formatInstructionsCache.set(schema, result);
  return result;
}

// ─── Custom tool validation ──────────────────────────────────────────────────

/**
 * Type guard + validator for a persisted custom-tool entry.
 *
 * Guarantees `name` matches the safe name regex and that `code`/`description`
 * are real strings of bounded length.
 */
function isValidCustomTool(value: unknown): value is CustomTool {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  if (typeof t.name !== "string" || !CUSTOM_TOOL_NAME_REGEX.test(t.name)) return false;
  if (typeof t.description !== "string" || t.description.length > MAX_CUSTOM_TOOL_DESCRIPTION_LENGTH) {
    return false;
  }
  if (typeof t.code !== "string" || t.code.length > MAX_CUSTOM_TOOL_CODE_LENGTH) return false;
  return true;
}

// ─── Custom tool description sanitization ────────────────────────────────────

/**
 * Sanitize a tool description before inlining it into the `<custom_tools>`
 * prompt block. Collapses whitespace, strips angle brackets, caps length.
 */
function sanitizeToolDescription(description: string): string {
  const collapsed = description.replace(/\s+/g, " ").trim();
  const stripped = collapsed.replace(/[<>]/g, "");
  if (stripped.length > RENDERED_TOOL_DESCRIPTION_LENGTH) {
    return stripped.slice(0, RENDERED_TOOL_DESCRIPTION_LENGTH).trimEnd() + "…";
  }
  return stripped;
}

// ─── Custom tool loading ─────────────────────────────────────────────────────

/**
 * Surface a swallowed storage/parse error on a debug channel.
 */
function logLoadError(source: string, err: unknown): void {
  if (typeof console !== "undefined" && typeof console.warn === "function") {
    console.warn(`[custom-tools] failed to load tools from ${source}:`, err);
  }
}

/** Module-level cache for custom tools. */
let customToolsCache: CustomTool[] | null = null;

/** Invalidate the custom-tools cache (called by storage onChanged listener). */
export function invalidateCustomToolsCache(): void {
  customToolsCache = null;
}

/**
 * Load all custom tools from storage.
 *
 * Returns an empty array on any storage / parse error so callers can safely
 * iterate without try/catch.
 */
async function loadCustomTools(): Promise<CustomTool[]> {
  if (customToolsCache !== null) return customToolsCache;
  if (isExtensionWithLocal()) {
    try {
      const res = await chrome.storage.local.get(CUSTOM_TOOLS_STORAGE_KEY);
      const raw = res[CUSTOM_TOOLS_STORAGE_KEY];
      if (!Array.isArray(raw)) {
        if (raw !== undefined) {
          logLoadError(
            "chrome.storage.local",
            new Error(`expected an array of custom tools, got ${typeof raw}`)
          );
        }
        return [];
      }
      customToolsCache = raw.filter(isValidCustomTool);
      return customToolsCache;
    } catch (err) {
      logLoadError("chrome.storage.local", err);
      return [];
    }
  }
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

// ─── Custom tools prompt block ───────────────────────────────────────────────

/**
 * Format the custom-tools list as a `<custom_tools>` prompt block.
 *
 * Returns an empty string when there are no custom tools.
 */
export async function formatCustomToolsBlock(): Promise<string> {
  const tools = await loadCustomTools();
  if (tools.length === 0) return "";
  // Cap the number of tools advertised so a large stored set cannot balloon
  // the prompt. The line count is bounded by MAX_CUSTOM_TOOLS_BLOCK; the
  // description of each tool is additionally sanitized + length-capped below.
  const visible = tools.slice(0, MAX_CUSTOM_TOOLS_BLOCK);
  const lines = visible.map(
    (t) => `- ${t.name}: ${sanitizeToolDescription(sanitizeUntrusted(t.description))}`,
  );
  if (tools.length > visible.length) {
    lines.push(`- … and ${tools.length - visible.length} more custom tool(s) not listed`);
  }
  return (
    "<custom_tools>\n" +
    "The following custom JavaScript tools are available. Use `evaluate` with " +
    "the exact expression `__opencowork_custom_tool('<name>')` to invoke one — " +
    "the runtime will substitute the stored code before execution.\n" +
    lines.join("\n") +
    "\n</custom_tools>"
  );
}

// ─── Custom tool call substitution ───────────────────────────────────────────

/** Regex matching `__opencowork_custom_tool('<name>')` calls. */
const CUSTOM_TOOL_NAME_PATTERN = CUSTOM_TOOL_NAME_REGEX.source.replace(/^\^|\$$/g, "");
const CUSTOM_TOOL_CALL_REGEX = new RegExp(
  "__opencowork_custom_tool\\s*\\(\\s*['\"](" + CUSTOM_TOOL_NAME_PATTERN + ")['\"]\\s*\\)",
  "g",
);

/**
 * Replace every `__opencowork_custom_tool('<name>')` call in `code` with the
 * stored source for that tool. Unknown tool names are left untouched.
 */
export async function substituteCustomToolCalls(
  code: string,
): Promise<string> {
  const tools = await loadCustomTools();
  if (tools.length === 0) return code;
  const byName = new Map(tools.map((t) => [t.name, t.code] as const));
  let result = code;
  let changed = true;
  let passes = 0;
  while (changed && passes < 3) {
    changed = false;
    passes++;
    result = result.replace(CUSTOM_TOOL_CALL_REGEX, (full, name: string) => {
      const sub = byName.get(name);
      if (sub === undefined) return full;
      changed = true;
      if (result.length + sub.length > MAX_SUBSTITUTION_RESULT_LENGTH) {
        return full;
      }
      const needsIife = /\breturn\b/.test(sub) || /\b(const|let|var|if|for|while|throw|do|switch|try|function|class)\b/.test(sub) || /;/.test(sub);
      const body = sub.endsWith("\n") ? sub : sub + "\n";
      return needsIife ? `(()=>{${body}})()` : `(${body})`;
    });
  }
  if (result.length > MAX_SUBSTITUTION_RESULT_LENGTH) return code;
  return result;
}
