/**
 * Types and constants for the tool registry.
 *
 * Split from `registry.ts` to separate data from logic.
 */

// ─── Format instructions ─────────────────────────────────────────────────────

/** The format-instructions preamble (kept short to minimise prompt tokens). */
export const FORMAT_INSTRUCTIONS_PREAMBLE =
  "The output should be formatted as a JSON instance that conforms to the JSON schema below.\n\nHere is the output schema:\n```";

// ─── Custom tools ────────────────────────────────────────────────────────────

/**
 * A user-defined custom tool. Stored verbatim in `chrome.storage.local`; the
 * agent invokes them via the existing `evaluate` action with the snippet
 * wrapped in `__opencowork_custom_tool('<name>')`.
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
  /** Truncated SHA-256 hex of `code` — operator-visible integrity fingerprint. */
  codeHash?: string;
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
 * `evaluate` payload from ballooning.
 */
export const MAX_CUSTOM_TOOL_CODE_LENGTH = 256 * 1024;

/**
 * Upper bound on the *substituted* result of `substituteCustomToolCalls`.
 * Each custom-tool body is capped at `MAX_CUSTOM_TOOL_CODE_LENGTH`, but a
 * single evaluate payload can reference many tools, so the substituted string is
 * bounded separately at 2x that cap.
 */
export const MAX_SUBSTITUTION_RESULT_LENGTH = 2 * MAX_CUSTOM_TOOL_CODE_LENGTH;

/** Maximum *rendered* length of a tool description in the `<custom_tools>` block. */
export const RENDERED_TOOL_DESCRIPTION_LENGTH = 200;

/**
 * Maximum *stored* length of a custom-tool `description`. Bounds the payload
 * that ends up in `chrome.storage.local` and in the prompt block.
 */
export const MAX_CUSTOM_TOOL_DESCRIPTION_LENGTH = 2000;
