/**
 * Zod schemas for every agent action — the single source of truth for the
 * action set. The schemas are consumed by:
 * - the tool registry (generates the LLM-facing JSON schema),
 * - the output parser (validates LLM responses),
 * - the action executor (narrows on the validated `type` discriminator).
 *
 * Using a `type` discriminator field (not `Object.keys()[0]`) lets TypeScript
 * narrow the union without casts and lets Zod produce a clean
 * `discriminatedUnion`.
 */

import { z } from "zod";
import { MAX_CUSTOM_TOOL_CODE_LENGTH } from "./registry";

// ─── Safe boolean coercion ─────────────────────────────────────────────────
//
// `z.coerce.boolean()` calls `Boolean(value)` under the hood, which means ANY
// non-empty string — including the literal string `"false"` — coerces to
// `true`. When a local/Ollama model emits `"success": "false"` (string, common
// with smaller models that stringify booleans), the agent would incorrectly
// report success. This helper accepts the common truthy/falsy encodings
// (boolean, "true"/"false" strings in any case, 1/0 number-or-string, null)
// and transforms them to a real boolean. Use it anywhere `z.coerce.boolean()`
// would have been used for a field that the LLM can populate.
// Accept `z.null()` — some local models emit `null` for booleans.
// Single source of truth for the accepted truthy spellings — both the `Set`
// used by the transform and the Zod union literals are derived from `TRUTHY`
// (plus the parallel falsey literals), so adding a new spelling can't desync
// the two.
const TRUTHY = [true, "true", "True", "TRUE", 1, "1"] as const;
const FALSEY = ["false", "False", "FALSE", "0", 0] as const;
const truthy = new Set<unknown>(TRUTHY);
/** Coerce a flexible boolean-like input to a real boolean (no truthy-string trap). */
export const flexibleBoolean = z
  .union([
    z.boolean(),
    z.null(),
    ...TRUTHY.map((v) => z.literal(v as never)),
    ...FALSEY.map((v) => z.literal(v as never)),
  ])
  .transform((v) => v !== null && truthy.has(v));

// ─── Bounded free-text helpers ───────────────────────────────────────────────
//
// LLM/prompt-injection-controlled strings flow into the executor, the agent
// context, and persistent storage. Cap every free-text field so a single huge
// model output can't exhaust extension storage, bloat exported history, or
// saturate the context window. Three tiers:
// - LONG (64 KiB): prose / query / question / reason / expectation fields.
// - CODE (256 KiB): `evaluate` JavaScript — mirrors the custom-tool cap, large
// enough for legitimate scripts but still bounded.
// - SHORT (8 KiB): selectors, URLs, key names, file paths, patterns.
const MAX_FREE_TEXT_CHARS = 64 * 1024; // 64 KiB
// 256 KiB — share the single source of truth with the custom-tool code cap.
const MAX_CODE_CHARS = MAX_CUSTOM_TOOL_CODE_LENGTH;
const MAX_SHORT_TEXT_CHARS = 8 * 1024; // 8 KiB

/** A free-text field capped to `max` characters after coercion. */
function boundedText(max: number, msg?: string): z.ZodType<string> {
  return z.coerce.string().max(max, msg ?? `text exceeds ${max} character limit`);
}

// ─── Individual action schemas ──────────────────────────────────────────────

/**
 * Click an interactive element by its `[index]`.
 *
 * The index may be either:
 * - a positive integer `[N]` referencing a DOM-extracted element, OR
 * - a `vN` string (e.g. `"v1"`) referencing a vision-only element emitted
 * by the Local Vision Assistant. Vision elements are clickable via CDP
 * coordinate clicks — see `click.ts:handleVisionClick`.
 *
 * The union tries the numeric arm first (so `"5"` and `5` both coerce to
 * `5`), then falls back to the `vN` regex arm for vision indices. The
 * inferred TS type is `number | string`.
 */
export const ClickSchema = z.object({
  type: z.literal("click").describe("Click an interactive element by its [index]."),
  index: z
    .union([
      z.coerce.number().int().min(1),
      z.string().regex(/^v\d+$/),
    ])
    .describe("The [index] of the element to click (e.g. 5, or v1 for a vision-only element)."),
});

/** Type text into an input or textarea element. */
export const InputSchema = z.object({
  type: z.literal("input").describe("Type text into an input or textarea element."),
  index: z.coerce.number().int().min(1).describe("The [index] of the input element."),
  text: boundedText(MAX_FREE_TEXT_CHARS).describe("The text to type."),
  clear: flexibleBoolean.optional().default(true).describe("If true (default), replace existing content; if false, append."),
});

/** Choose an option in a `<select>` dropdown by its visible text or index. */
export const SelectDropdownSchema = z
  .object({
    type: z.literal("select_dropdown").describe("Choose an option in a <select> dropdown."),
    index: z.coerce.number().int().min(1).describe("The [index] of the <select> element."),
    text: boundedText(MAX_FREE_TEXT_CHARS).optional().describe("The exact visible text (or value) of the option to select. Use this OR option_index."),
    option_index: z.coerce.number().int().min(0).optional().describe("0-based index of the option (from dropdown_options output). Use this OR text."),
  })
  .refine((d) => (d.text !== undefined && d.text.trim() !== "") || d.option_index !== undefined, {
    message: "must provide either text or option_index",
  });

/** Scroll the page up or down by whole viewport-heights. */
export const ScrollSchema = z.object({
  type: z.literal("scroll").describe("Scroll the page up or down."),
  down: flexibleBoolean.optional().default(true).describe("true = scroll down (default), false = scroll up."),
  pages: z.coerce.number().min(0).max(100).optional().default(1).describe("Number of viewport-heights to scroll (default 1, capped at 100)."),
});

/** Press a single key or a key combination (e.g. Enter, Ctrl+S). */
export const SendKeysSchema = z.object({
  type: z.literal("send_keys").describe("Press a key or key combination (e.g. 'Enter', 'Escape', 'Tab')."),
  keys: z.coerce.string().min(1).max(MAX_SHORT_TEXT_CHARS).describe("The key name: Enter, Escape, Tab, Space, ArrowUp/Down/Left/Right, Backspace, or a printable character."),
});

/** Navigate to a URL (optionally in a new tab). Page-changing — put LAST. */
export const NavigateSchema = z.object({
  type: z.literal("navigate").describe("Navigate to a URL. This is a page-changing action — put it LAST in your action list."),
  url: boundedText(MAX_SHORT_TEXT_CHARS).describe("The URL to navigate to."),
  new_tab: flexibleBoolean.optional().default(false).describe("If true, open in a new tab."),
});

/** Switch to another open tab by its numeric id. Page-changing — put LAST. */
export const SwitchTabSchema = z.object({
  type: z.literal("switch_tab").describe("Switch to another open tab. Page-changing — put LAST."),
  tab_id: z.coerce.number().int().describe("The numeric id of the tab to switch to (from the Open tabs list)."),
});

/** Close a tab by its numeric id. Page-changing — put LAST. */
export const CloseTabSchema = z.object({
  type: z.literal("close_tab").describe("Close a tab by its numeric id."),
  tab_id: z.coerce.number().int().describe("The numeric id of the tab to close."),
});

/** Click the browser's back button. Page-changing — put LAST. */
export const GoBackSchema = z.object({
  type: z.literal("go_back").describe("Click the browser's back button. Page-changing — put LAST."),
});

/** Wait for the page to load or settle (or for a fixed number of seconds). */
export const WaitSchema = z.object({
  type: z.literal("wait").describe("Wait for the page to load or settle."),
 // `z.coerce.number()` calls `Number(v)` under the hood, so
 // `null` and `""` coerce to 0 (not undefined), defeating `.default(3)`.
 // The preprocess converts null/"" → undefined BEFORE coercion so the
 // default kicks in.
 // Bound the value to [0, 300]: a negative `seconds` would resolve to a
 // near-instant `setTimeout(0)` (wrong behavior) and an unbounded value could
 // hang the orchestrator, which awaits this handler with no per-step timeout.
  seconds: z.preprocess(
    (v) => (v === null || v === "" ? undefined : v),
    z.coerce.number().min(0).max(300),
  ).optional().default(3).describe("Seconds to wait (default 3, clamped to 0–300)."),
});

/** Scroll the page until the given text becomes visible. */
export const FindTextSchema = z.object({
  type: z.literal("find_text").describe("Scroll the page until the given text becomes visible."),
  text: boundedText(MAX_FREE_TEXT_CHARS).describe("The text to search for and scroll to."),
});

/** Extract specific information from the full page text using a query. */
export const ExtractSchema = z.object({
  type: z.literal("extract").describe("Extract specific information from the full page text using a query. Use when the info you need is not in the interactive elements list."),
  query: boundedText(MAX_FREE_TEXT_CHARS).describe("A specific question describing what to extract from the page."),
});

/** Finish the task. MUST be the only action in its step. */
export const DoneSchema = z.object({
  type: z.literal("done").describe("Finish the task. MUST be the ONLY action in the step."),
 // `z.coerce.string()` calls `String(v)` under the hood, so
 // `null` becomes the literal string `"null"` — and the user sees "null"
 // as their task summary if the LLM emits `{"text": null}` (some local
 // models do this when they have nothing to summarize). The preprocess
 // converts null/undefined → "" BEFORE coercion, preserving the existing
 // coercion behavior for other types (numbers, booleans → stringified)
 // so the existing "model emits text as number" test still passes.
  text: z.preprocess(
    (v) => (v === null || v === undefined ? "" : v),
    z.coerce.string().max(MAX_FREE_TEXT_CHARS),
  ).describe("A summary of what was accomplished, including all results the user asked for."),
  success: flexibleBoolean.describe("true ONLY if the entire user request is fully complete; false otherwise."),
});

/** Search the web using a search engine. Page-changing — put LAST. */
export const SearchSchema = z.object({
  type: z.literal("search").describe("Search the web using a search engine. Page-changing — put LAST."),
  query: boundedText(MAX_FREE_TEXT_CHARS).describe("The search query."),
  engine: z.enum(["google", "bing", "duckduckgo", "yahoo", "baidu"]).optional().default("duckduckgo").describe("Search engine: duckduckgo, google, bing, yahoo, or baidu (default duckduckgo)."),
});

/** Upload a file to a file input element. */
export const UploadFileSchema = z.object({
  type: z.literal("upload_file").describe("Upload a file to a file input element."),
  index: z.coerce.number().int().min(1).describe("The [index] of the file input element."),
  path: boundedText(MAX_SHORT_TEXT_CHARS).describe("The path to the file to upload."),
});

/** Take a screenshot of the current page. */
export const ScreenshotSchema = z.object({
  type: z.literal("screenshot").describe("Take a screenshot of the current page."),
  file_name: z.string().max(MAX_SHORT_TEXT_CHARS).optional().describe("Optional filename for the screenshot."),
});

/** Save the current page as a PDF. */
export const SaveAsPdfSchema = z.object({
  type: z.literal("save_as_pdf").describe("Save the current page as a PDF."),
  file_name: z.string().max(MAX_SHORT_TEXT_CHARS).optional().describe("Optional filename for the PDF."),
});

/** List all options of a `<select>` dropdown element. */
export const DropdownOptionsSchema = z.object({
  type: z.literal("dropdown_options").describe("Get all options of a <select> dropdown element."),
  index: z.coerce.number().int().min(1).describe("The [index] of the <select> element."),
});

/** Search for text/regex on the current page (instant, free). */
export const SearchPageSchema = z.object({
  type: z.literal("search_page").describe("Search for text/pattern on the current page (instant, free). Use before scrolling to find specific content."),
  pattern: boundedText(MAX_SHORT_TEXT_CHARS).describe("The text or regex pattern to search for."),
  regex: flexibleBoolean.optional().default(false).describe("If true, treat pattern as a regular expression."),
  case_sensitive: flexibleBoolean.optional().default(false).describe("If true, case-sensitive search."),
});

/** Find elements matching a CSS selector (instant, free). */
export const FindElementsSchema = z.object({
  type: z.literal("find_elements").describe("Find elements matching a CSS selector (instant, free). Great for counting items or getting attributes."),
  selector: boundedText(MAX_SHORT_TEXT_CHARS).describe("CSS selector to match."),
  attributes: z.array(z.coerce.string()).max(20).optional().describe("Attributes to extract from each match (max 20)."),
 // preprocess null/"" → undefined so `.default(50)` applies
 // (otherwise `Number("") === 0` coerces successfully and bypasses the default).
  max_results: z.preprocess(
    (v) => (v === null || v === "" ? undefined : v),
    z.coerce.number().int().min(1).max(200),
  ).optional().default(50).describe("Max results to return (default 50, capped at 200)."),
});

/** Execute arbitrary JavaScript on the page. Page-changing — put LAST. */
export const EvaluateSchema = z.object({
  type: z.literal("evaluate").describe("Execute JavaScript on the page. Page-changing — put LAST. Use only when no other action works."),
  code: boundedText(MAX_CODE_CHARS).describe("JavaScript code to execute (wrapped in an IIFE). Only browser APIs, no Node.js."),
});

/** Hover over an element to trigger menus or tooltips. */
export const HoverSchema = z.object({
  type: z.literal("hover").describe("Hover over an element to trigger menus or tooltips."),
  index: z.coerce.number().int().min(1).describe("The [index] of the element to hover."),
});

/**
 * Press and hold an element for a duration (anti-bot "press-and-hold to verify"
 * widgets, Cloudflare Turnstile checkboxes). Falls back to a regular click
 * when the CDP debugger isn't available (in-page demo / tests).
 *
 * Page-changing — put LAST in the action list (some widgets navigate after a
 * successful hold).
 */
export const PressAndHoldSchema = z.object({
  type: z.literal("press_and_hold").describe("Press and hold an element (anti-bot 'press and hold to verify' widgets). Page-changing — put LAST."),
  index: z.coerce.number().int().min(1).describe("The [index] of the element to press and hold."),
 // preprocess null/"" → undefined so `.default(1500)` applies
 // (otherwise `Number(null) === 0` coerces successfully and bypasses the default).
  hold_ms: z.preprocess(
    (v) => (v === null || v === "" ? undefined : v),
    z.coerce.number().int().min(0).max(60000),
  ).optional().default(1500).describe("How long to hold the mouse button down, in milliseconds (default 1500, capped at 60000)."),
  delay_ms: z.coerce.number().int().min(0).max(60000).optional().default(0).describe("Optional pre-press hover-settle delay, in milliseconds (default 0, capped at 60000)."),
});

/** Ask the user a question when stuck or needing a decision. */
export const AskHumanSchema = z.object({
  type: z.literal("ask_human").describe("Ask the user a question. Use when stuck, confused, or needing a decision."),
  question: boundedText(MAX_FREE_TEXT_CHARS).describe("The question to ask the user."),
  mode: z.enum(["input", "password"]).optional().default("input").describe("Input mode: 'input' (default, visible text) or 'password' (masked — use for credentials, API keys, tokens)."),
});

/** Pause the agent and let the user perform an action manually.
 *
 * Use for logins, payments, captchas, or any sensitive action the agent
 * should not perform on its own. After emitting this action, the orchestrator
 * pauses and waits for the user to click "Resume" in the side panel (with a
 * 5-minute timeout). The agent then re-observes the page and continues. */
export const TakeoverSchema = z.object({
  type: z.literal("takeover").describe("Pause the agent and let the user perform an action manually. Use for logins, payments, captchas, or any sensitive action the agent should not perform."),
  reason: boundedText(MAX_FREE_TEXT_CHARS).describe("Why the user needs to take over (e.g. 'Login required', 'Payment form detected', 'CAPTCHA present')."),
});

/** Verify that the last action had the expected effect.
 *
 * Use after clicks that should change the page, form submissions, or any
 * action where success is uncertain. The `expectation` is recorded in history
 * so the next navigator step can check the page against it. */
export const VerifySchema = z.object({
  type: z.literal("verify").describe("Verify that the last action had the expected effect. Use after clicks that should change the page, form submissions, or any action where success is uncertain."),
  expectation: boundedText(MAX_FREE_TEXT_CHARS).describe("What you expect to see if the action succeeded (e.g. 'success message visible', 'new page loaded', 'form cleared')."),
});

/** Load full instructions for a domain skill.
 *
 * The navigator sees only the skill name + one-sentence frontmatter in the
 * <available_skills> block (always in context, ~10 tokens/skill). When the
 * current page matches a skill and the navigator needs the full tips +
 * shortcuts + dangerous-actions list, it emits `load_skill` and the executor
 * returns the full instruction body as `extractedContent` for the next step. */
export const LoadSkillSchema = z.object({
  type: z.literal("load_skill").describe("Load full instructions for a domain skill. Use when you need site-specific tips for the current page."),
  name: boundedText(MAX_FREE_TEXT_CHARS).describe("The skill name (from the <available_skills> list)."),
});

/** Accept the currently-open JavaScript dialog (alert / confirm / prompt). */
export const AlertAcceptSchema = z.object({
  type: z.literal("alert_accept").describe("Accept the currently-open JS dialog (alert/confirm/prompt). Returns failure if no dialog is open."),
});

/** Dismiss the currently-open JavaScript dialog (alert / confirm / prompt). */
export const AlertDismissSchema = z.object({
  type: z.literal("alert_dismiss").describe("Dismiss the currently-open JS dialog (alert/confirm/prompt). Returns failure if no dialog is open."),
});

/** Get the text of the currently-open JavaScript dialog. */
export const AlertGetTextSchema = z.object({
  type: z.literal("alert_get_text").describe("Get the text of the currently-open JS dialog. Returns empty string if no dialog is open."),
});

/** Queue `text` to be returned by the next `window.prompt()` call. */
export const AlertSendKeysSchema = z.object({
  type: z.literal("alert_send_keys").describe("Stage text to be returned by the NEXT window.prompt() call. window.prompt is synchronous, so once a prompt has fired the page already received the auto-dismiss override's empty-string return — there is no way to retroactively deliver text. Call this BEFORE triggering the action that opens the prompt so the staged text reaches the page. When no dialog is open the text is staged (success); returns failure for non-prompt dialogs (alert/confirm)."),
  text: boundedText(MAX_FREE_TEXT_CHARS).describe("The text to stage for the next prompt dialog."),
});

/** Run local vision detection (LocateAnything-3B) on the current screenshot. */
export const DetectVisualSchema = z.object({
  type: z.literal("detect_visual").describe("Run local vision detection on the current screenshot to find UI elements that aren't in the DOM tree (Canvas, WebGL, custom widgets, image-based buttons). Returns [v1], [v2] etc. entries you can click with {\"type\":\"click\",\"index\":\"v1\"}. Use ONLY when you can see something visually on the page but can't find it in the elements list. Takes 2-5 seconds. Only available when Local Vision Assistant is enabled in AI Adaptive mode."),
  query: boundedText(MAX_FREE_TEXT_CHARS).describe("What you're looking for (e.g. 'submit button', 'login form', 'canvas dropdown')."),
});

// ─── Union + helpers ────────────────────────────────────────────────────────

/** Discriminated union of all action schemas (32 actions). */
export const ActionSchema = z.discriminatedUnion("type", [
  ClickSchema,
  InputSchema,
  SelectDropdownSchema,
  ScrollSchema,
  SendKeysSchema,
  NavigateSchema,
  SwitchTabSchema,
  CloseTabSchema,
  GoBackSchema,
  WaitSchema,
  FindTextSchema,
  ExtractSchema,
  DoneSchema,
  SearchSchema,
  UploadFileSchema,
  ScreenshotSchema,
  SaveAsPdfSchema,
  DropdownOptionsSchema,
  SearchPageSchema,
  FindElementsSchema,
  EvaluateSchema,
  HoverSchema,
  PressAndHoldSchema,
  AskHumanSchema,
  TakeoverSchema,
  VerifySchema,
  LoadSkillSchema,
  AlertAcceptSchema,
  AlertDismissSchema,
  AlertGetTextSchema,
  AlertSendKeysSchema,
  DetectVisualSchema,
]);

/** Schema for the navigator's per-step structured output.
 *
 * Tolerant of model variation:
 * - `evaluation_previous_goal` is optional with a default — many models omit
 * it on step 0 (no previous goal to evaluate yet).
 * - `thinking`/`memory`/`next_goal` default to empty strings so a model that
 * emits only `action` still validates.
 * - Extra/unknown fields are stripped (Zod default), so a model that adds
 * e.g. `"confidence": 0.9` doesn't fail validation.
 */
export const AgentOutputSchema = z.object({
  thinking: z.string().default("").describe("Your step-by-step reasoning about the current state and what to do next."),
  evaluation_previous_goal: z.string().default("").describe("One sentence: did your last action succeed, fail, or is uncertain? End with 'Verdict: Success' or 'Verdict: Failure'."),
  memory: z.string().default("").describe("1-3 sentences tracking progress (what's done, what's next, counts)."),
  next_goal: z.string().default("").describe("One clear sentence stating the immediate goal of this step."),
  action: z
    .array(ActionSchema)
    .min(1)
    .max(50)
 // Exclusive actions (see ACTION_METADATA[*].exclusive — e.g. `done`,
 // `ask_human`, `takeover`, `detect_visual`) MUST be the only action in
 // their step. Any sibling actions would otherwise be silently dropped by
 // the orchestrator's short-circuit paths (e.g. short-circuit-to-done) or
 // never reach execution. The prompt already tags these "[must be the only
 // action]", and the metadata flag drives this check, so the parser and the
 // prompt stay consistent and the flag is not dead data. Enforce at parse
 // time so invalid multi-action steps (e.g. [{type:"done"},{type:"input"}])
 // are rejected before they reach execution. A single exclusive action (the
 // valid case) is unaffected.
    .superRefine((actions, ctx) => {
      const exclusive = actions.filter((a) => ACTION_METADATA[a.type]?.exclusive);
      if (exclusive.length > 0 && actions.length > 1) {
        const names = exclusive.map((a) => a.type).join(", ");
        ctx.addIssue({
          code: "custom",
          message: `Exclusive action(s) [${names}] must be the only action in the step.`,
        });
      }
    })
    .describe("1-50 actions to execute sequentially. Page-changing actions (navigate, switch_tab, go_back) must be LAST."),
});

/** Schema for the planner's per-step structured output. */
export const PlannerOutputSchema = z.object({
  thinking: z.string().describe("Your reasoning about overall progress toward the user's task."),
  decision: z.enum(["continue", "done", "web_task"]).describe("'continue' = keep running the navigator; 'done' = task is finished (or impossible); 'web_task' = answer directly without browser (for pure-knowledge questions)."),
  success: flexibleBoolean.optional().describe("When decision='done': true only if the task is fully complete."),
  text: z.string().optional().describe("When decision='done' or 'web_task': the final answer/summary for the user."),
  plan: z.array(z.string()).optional().describe("When decision='continue': the updated step-by-step plan (replaces the old plan). 3-10 concise items."),
  current_plan_item: z.number().int().optional().describe("When decision='continue': 0-indexed number of the plan item currently being worked on."),
  next_goal: z.string().optional().describe("When decision='continue': the immediate goal to hand to the navigator."),
});

/** Inferred TS type for a single validated action. */
export type Action = z.infer<typeof ActionSchema>;

// ─── Action metadata (for the prompt + executor) ────────────────────────────

/** Static metadata about an action — used to render the prompt and guide execution. */
export interface ActionMeta {
  /** Action name (matches the `type` discriminator). */
  name: string;
  /** Human-readable description for the system prompt. */
  description: string;
  /** Whether executing this action likely changes the page (abort remaining queue). */
  pageChanging: boolean;
  /** Whether this action must be the only action in its step. */
  exclusive: boolean;
  /** Parameter signature for the prompt, e.g. `index: number, text: string`. */
  params: string;
}

/** Metadata for every action in the action set. */
export const ACTION_METADATA: Record<string, ActionMeta> = {
  click:              { name: "click",              description: "Click an interactive element by index.",                pageChanging: false, exclusive: false, params: "index: number" },
  input:              { name: "input",              description: "Type text into an input/textarea.",                    pageChanging: false, exclusive: false, params: "index: number, text: string, clear?: boolean (default true = replace)" },
  select_dropdown:    { name: "select_dropdown",    description: "Choose an option in a <select>.",                      pageChanging: false, exclusive: false, params: "index: number, text?: string OR option_index?: number" },
  scroll:             { name: "scroll",             description: "Scroll the page.",                                     pageChanging: false, exclusive: false, params: "down?: boolean (default true), pages?: number (default 1)" },
  send_keys:          { name: "send_keys",          description: "Press a key (Enter, Escape, Tab...).",                 pageChanging: false, exclusive: false, params: "keys: string" },
  navigate:           { name: "navigate",           description: "Go to a URL (optionally new tab).",                    pageChanging: true,  exclusive: false, params: "url: string, new_tab?: boolean (default false)" },
  switch_tab:         { name: "switch_tab",         description: "Switch to another open tab.",                          pageChanging: true,  exclusive: false, params: "tab_id: number" },
  close_tab:          { name: "close_tab",          description: "Close a tab.",                                         pageChanging: true,  exclusive: false, params: "tab_id: number" },
  go_back:            { name: "go_back",            description: "Browser back button.",                                 pageChanging: true,  exclusive: false, params: "(none)" },
  wait:               { name: "wait",               description: "Wait for the page to settle.",                         pageChanging: false, exclusive: false, params: "seconds?: number (default 3)" },
  find_text:          { name: "find_text",          description: "Scroll until text is visible.",                        pageChanging: false, exclusive: false, params: "text: string" },
  extract:            { name: "extract",            description: "Extract info from page text via a query.",             pageChanging: false, exclusive: false, params: "query: string" },
  done:               { name: "done",               description: "Finish the task.",                                     pageChanging: false, exclusive: true,  params: "text: string (summary), success: boolean" },
  search:             { name: "search",             description: "Search the web (DuckDuckGo/Google/Bing).",             pageChanging: true,  exclusive: false, params: "query: string, engine?: 'duckduckgo'|'google'|'bing'|'yahoo'|'baidu'" },
  upload_file:        { name: "upload_file",        description: "Upload a file to a file input.",                       pageChanging: false, exclusive: false, params: "index: number, path: string" },
  screenshot:         { name: "screenshot",         description: "Take a screenshot of the page.",                       pageChanging: false, exclusive: false, params: "file_name?: string" },
  save_as_pdf:        { name: "save_as_pdf",        description: "Save the page as a PDF.",                              pageChanging: false, exclusive: false, params: "file_name?: string" },
  dropdown_options:   { name: "dropdown_options",   description: "List options of a <select>.",                          pageChanging: false, exclusive: false, params: "index: number" },
  search_page:        { name: "search_page",        description: "Search for text/pattern on the page (instant, free).", pageChanging: false, exclusive: false, params: "pattern: string, regex?: boolean, case_sensitive?: boolean" },
  find_elements:      { name: "find_elements",      description: "Find elements by CSS selector (instant, free).",       pageChanging: false, exclusive: false, params: "selector: string, attributes?: string[], max_results?: number" },
  evaluate:           { name: "evaluate",           description: "Execute JavaScript on the page.",                      pageChanging: true,  exclusive: false, params: "code: string" },
  hover:              { name: "hover",              description: "Hover over an element.",                               pageChanging: false, exclusive: false, params: "index: number" },
  press_and_hold:     { name: "press_and_hold",     description: "Press and hold an element (anti-bot widgets).",        pageChanging: true,  exclusive: false, params: "index: number, hold_ms?: number (default 1500), delay_ms?: number (default 0)" },
  ask_human:          { name: "ask_human",          description: "Ask the user a question when stuck.",                  pageChanging: false, exclusive: true,  params: "question: string, mode?: 'input'|'password' (default 'input')" },
  takeover:           { name: "takeover",           description: "Pause for user to act manually.",                      pageChanging: false, exclusive: true,  params: "reason: string" },
  verify:             { name: "verify",             description: "Verify the last action had the expected effect.",       pageChanging: false, exclusive: false, params: "expectation: string" },
  load_skill:         { name: "load_skill",         description: "Load full instructions for a domain skill.",            pageChanging: false, exclusive: false, params: "name: string" },
  alert_accept:       { name: "alert_accept",       description: "Accept the open JS dialog (alert/confirm/prompt).",     pageChanging: false, exclusive: false, params: "(none)" },
  alert_dismiss:      { name: "alert_dismiss",      description: "Dismiss the open JS dialog (alert/confirm/prompt).",    pageChanging: false, exclusive: false, params: "(none)" },
  alert_get_text:     { name: "alert_get_text",     description: "Get the text of the open JS dialog.",                   pageChanging: false, exclusive: false, params: "(none)" },
  alert_send_keys:    { name: "alert_send_keys",    description: "Queue text for the next window.prompt() call (call BEFORE the action that opens the prompt).",             pageChanging: false, exclusive: false, params: "text: string" },
  detect_visual:      { name: "detect_visual",      description: "Run local vision detection to find UI elements not in the DOM (Canvas, WebGL, custom widgets). Returns [v1], [v2] etc. that you can click. Use ONLY when you can see something visually but can't find it in the elements list.",  pageChanging: false, exclusive: true,  params: "query: string" },
};

/**
 * Render the human-readable action list for the system prompt, including
 * parameter signatures + page-changing / exclusive tags.
 *
 * The parameter signature is critical for providers that don't pass the Zod
 * schema to the LLM (OpenAI JSON mode, Anthropic, Gemini, Ollama, local models) — without
 * it, the model can only guess parameter names from the examples at the bottom
 * of the prompt. Including `params` here makes the prompt self-sufficient for
 * ALL providers/models.
 *
 * @param maxActions The maximum number of actions the navigator may emit per step.
 */
// Cache the action list by maxActions + visionMode — the output only changes
// when either changes (rare), but the function is called every navigator step.
const actionListCache = new Map<string, string>();

export function actionListForPrompt(maxActions: number, visionMode: "disabled" | "always" | "adaptive" = "disabled"): string {
  const cacheKey = `${maxActions}:${visionMode}`;
  const cached = actionListCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const lines: string[] = [];
  for (const meta of Object.values(ACTION_METADATA)) {
 // Skip detect_visual when vision mode doesn't use it as a tool
    if (meta.name === "detect_visual" && visionMode !== "adaptive") continue;
    const tag = meta.pageChanging
      ? " [page-changing — put last]"
      : meta.exclusive
        ? " [must be the only action]"
        : "";
    lines.push(`- ${meta.name}${tag} — ${meta.description} | params: { ${meta.params} }`);
  }
  const result = `You may output 1 to ${maxActions} actions per step. Available actions:\n${lines.join("\n")}`;
  actionListCache.set(cacheKey, result);
  return result;
}

// ─── Action equivalence (for early-stop loop detection) ─────────────────────
//
// `isEquivalentAction(a, b)` returns `true` when two actions have the same
// effect on the page — used by the orchestrator's early-stop detector to
// spot when the agent repeats the same action 3+ times in a row.
//
// Per-type comparison:
// - CLICK / HOVER / INPUT / SELECT_DROPDOWN: same `index`.
// - SCROLL: same direction (down vs up).
// - SEND_KEYS: same `keys`.
// - NAVIGATE: same `url`.
// - SWITCH_TAB / CLOSE_TAB: same `tab_id`.
// - GO_BACK / WAIT / DONE / TAKEOVER / ASK_HUMAN / VERIFY / LOAD_SKILL /
// SEARCH_PAGE / FIND_ELEMENTS / FIND_TEXT / EXTRACT / DROPDOWN_OPTIONS /
// EVALUATE: compared by their distinguishing param (or always-equivalent
// for parameterless actions like GO_BACK).
// - SCREENSHOT / SAVE_AS_PDF: compared by `file_name` (different filenames =
// distinct actions).
// - SEARCH: same `query` (+ engine when specified).
//
// Different action types are NEVER equivalent.
export function isEquivalentAction(a: Action, b: Action): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "click":
    case "hover":
      return a.index === (b as Extract<Action, { type: typeof a.type }>).index;
    case "press_and_hold": {
      const bb = b as Extract<Action, { type: "press_and_hold" }>;
      return a.index === bb.index && (a.hold_ms ?? 1500) === (bb.hold_ms ?? 1500);
    }
    case "input":
 // `index` is a per-field ordinal, NOT part of "same action" identity for
 // the early-stop detector. Typing the same `text` into 3+ different
 // fields is suspicious (caught by the whole-history cross-field branch in
 // early-stop.ts) and must NOT be treated as a distinct action. Compare
 // only the stable distinguishing field (`text`) so cross-field repeats
 // are detected. (`alert_send_keys` is already text-only below.)
      return a.text === (b as Extract<Action, { type: "input" }>).text;
    case "select_dropdown": {
      const bb = b as Extract<Action, { type: "select_dropdown" }>;
      return a.index === bb.index && (a.text ?? "") === (bb.text ?? "") && (a.option_index ?? -1) === (bb.option_index ?? -1);
    }
    case "scroll": {
      const bb = b as Extract<Action, { type: "scroll" }>;
      return (a.down === false ? "up" : "down") === (bb.down === false ? "up" : "down");
    }
    case "send_keys":
      return a.keys === (b as Extract<Action, { type: "send_keys" }>).keys;
    case "navigate":
      return a.url === (b as Extract<Action, { type: "navigate" }>).url;
    case "switch_tab":
    case "close_tab":
      return a.tab_id === (b as Extract<Action, { type: typeof a.type }>).tab_id;
    case "go_back":
    case "wait":
 // Both are essentially parameterless from the loop-detector's POV.
 // `wait.seconds` differences don't matter — repeating wait(s) of any
 // duration is the same kind of stuck.
      return true;
    case "find_text":
      return a.text === (b as Extract<Action, { type: "find_text" }>).text;
    case "extract":
      return a.query === (b as Extract<Action, { type: "extract" }>).query;
    case "done": {
      const bb = b as Extract<Action, { type: "done" }>;
      return a.text === bb.text && a.success === bb.success;
    }
    case "search": {
      const bb = b as Extract<Action, { type: "search" }>;
      return a.query === bb.query && (a.engine ?? "duckduckgo") === (bb.engine ?? "duckduckgo");
    }
    case "upload_file":
      return (
        a.index === (b as Extract<Action, { type: "upload_file" }>).index &&
        a.path === (b as Extract<Action, { type: "upload_file" }>).path
      );
    case "screenshot":
    case "save_as_pdf":
 // Two screenshots / PDFs to DIFFERENT filenames are distinct actions
 // (e.g. capturing evidence at different steps), so compare `file_name`.
 // Only genuinely parameterless actions (go_back, alert_accept/dismiss/
 // get_text) are always-equivalent.
      return (a.file_name ?? "") === ((b as Extract<Action, { type: "screenshot" | "save_as_pdf" }>).file_name ?? "");
    case "dropdown_options":
      return a.index === (b as Extract<Action, { type: "dropdown_options" }>).index;
    case "search_page":
      return (
        a.pattern === (b as Extract<Action, { type: "search_page" }>).pattern &&
        a.regex === (b as Extract<Action, { type: "search_page" }>).regex &&
        (a.case_sensitive ?? false) ===
          ((b as Extract<Action, { type: "search_page" }>).case_sensitive ?? false)
      );
    case "find_elements": {
      const bb = b as Extract<Action, { type: "find_elements" }>;
      return (
        a.selector === bb.selector &&
        JSON.stringify(a.attributes ?? []) === JSON.stringify(bb.attributes ?? []) &&
        (a.max_results ?? 50) === (bb.max_results ?? 50)
      );
    }
    case "evaluate":
      return a.code === (b as Extract<Action, { type: "evaluate" }>).code;
    case "ask_human": {
      const bb = b as Extract<Action, { type: "ask_human" }>;
      return a.question === bb.question && (a.mode ?? "input") === (bb.mode ?? "input");
    }
    case "takeover":
      return a.reason === (b as Extract<Action, { type: "takeover" }>).reason;
    case "verify":
      return a.expectation === (b as Extract<Action, { type: "verify" }>).expectation;
    case "load_skill":
      return a.name === (b as Extract<Action, { type: "load_skill" }>).name;
    case "alert_accept":
    case "alert_dismiss":
    case "alert_get_text":
 // All three are parameterless — equivalent to themselves.
      return true;
    case "alert_send_keys":
      return a.text === (b as Extract<Action, { type: "alert_send_keys" }>).text;
    case "detect_visual":
      return a.query === (b as Extract<Action, { type: "detect_visual" }>).query;
    default: {
 // Exhaustiveness guard — every known action type has a `case` above, so
 // this branch is unreachable for the current union. For any unknown/future
 // action type, treat it as NOT equivalent (safe default for loop detection).
      const _exhaustive: never = a;
      void _exhaustive;
      return false;
    }
  }
}
