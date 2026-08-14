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
import { flexibleBoolean, boundedText, MAX_FREE_TEXT_CHARS, MAX_CODE_CHARS, MAX_SHORT_TEXT_CHARS, ACTION_METADATA } from "./schema-utils";

// ─── Individual action schemas ──────────────────────────────────────────────

/** Click an interactive element by its `[index]`. */
const ClickSchema = z.object({
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
  humanized: z.boolean().optional().describe("OPT-IN: type via browser-trusted CDP key events (slower, more human). Defaults to instant value-set."),
});

/** Choose an option in a `<select>` dropdown by its visible text or index. */
const SelectDropdownSchema = z
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
const ScrollSchema = z.object({
  type: z.literal("scroll").describe("Scroll the page up or down."),
  down: flexibleBoolean.optional().default(true).describe("true = scroll down (default), false = scroll up."),
  pages: z.coerce.number().min(0).max(100).optional().default(1).describe("Number of viewport-heights to scroll (default 1, capped at 100)."),
});

/** Scroll the page to the very bottom, then restore the viewport to the top. */
const ScrollToBottomSchema = z.object({
  type: z.literal("scroll_to_bottom").describe("Scroll to the very bottom of the page, then restore the viewport to the top."),
  delay_seconds: z.coerce.number().min(0).max(10).optional().default(0.4).describe("Seconds to wait after each viewport scroll for lazy content (default 0.4, capped at 10)."),
});

/** Press a single key or a key combination (e.g. Enter, Ctrl+S). */
const SendKeysSchema = z.object({
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
const SwitchTabSchema = z.object({
  type: z.literal("switch_tab").describe("Switch to another open tab. Page-changing — put LAST."),
  tab_id: z.coerce.number().int().describe("The numeric id of the tab to switch to (from the Open tabs list)."),
});

/** Close a tab by its numeric id. Page-changing — put LAST. */
const CloseTabSchema = z.object({
  type: z.literal("close_tab").describe("Close a tab by its numeric id."),
  tab_id: z.coerce.number().int().describe("The numeric id of the tab to close."),
});

/** Click the browser's back button. Page-changing — put LAST. */
const GoBackSchema = z.object({
  type: z.literal("go_back").describe("Click the browser's back button. Page-changing — put LAST."),
});

/** Wait for the page to load or settle (or for a fixed number of seconds). */
export const WaitSchema = z.object({
  type: z.literal("wait").describe("Wait for the page to load or settle."),
  // Plain coerce like `pages`: `z.coerce.number()` maps null/'' to 0, so the
  // LLM emitting null/'' for seconds is tolerated instead of failing the parse
  // (a preprocess→undefined pipeline made coerce see NaN and throw invalid_type).
  seconds: z.coerce.number().min(0).max(300).optional().default(3).describe("Seconds to wait (default 3, clamped to 0–300)."),
});

/** Wait until an element reaches a visibility / attachment state. */
export const WaitForElementSchema = z.object({
  type: z.literal("wait_for_element").describe("Wait until an element matches the requested state. Fails if the state is not reached within the timeout."),
  selector: boundedText(MAX_SHORT_TEXT_CHARS).describe("CSS selector of the element to wait for."),
  state: z.enum(["visible", "hidden", "attached", "detached"]).optional().default("visible").describe("Desired state: visible (default), hidden, attached (in DOM), or detached (not in DOM)."),
  timeout_seconds: z.coerce.number().min(0).max(300).optional().default(30).describe("Seconds to wait before failing (default 30)."),
});

/** Wait until the given text appears in the page's visible text. */
const WaitForTextSchema = z.object({
  type: z.literal("wait_for_text").describe("Wait until the given text is present in the page's visible text (substring match)."),
  text: boundedText(MAX_FREE_TEXT_CHARS).describe("Text to look for in the page body."),
  timeout_seconds: z.coerce.number().min(0).max(300).optional().default(30).describe("Seconds to wait before failing (default 30)."),
});

/** Wait until the page URL matches a glob pattern. */
const WaitForUrlSchema = z.object({
  type: z.literal("wait_for_url").describe("Wait until the page URL matches a glob pattern. `*` matches anything except `/`, `**` matches everything."),
  url: boundedText(MAX_SHORT_TEXT_CHARS).describe("Glob pattern for the URL (e.g. **/settings/account)."),
  timeout_seconds: z.coerce.number().min(0).max(300).optional().default(30).describe("Seconds to wait before failing (default 30)."),
});

/** Wait until the network is idle (no new resource loads for 500ms). */
const WaitForNetworkIdleSchema = z.object({
  type: z.literal("wait_for_network_idle").describe("Wait until the network is idle (no new resource loads for 500ms)."),
  timeout_seconds: z.coerce.number().min(0).max(300).optional().default(30).describe("Seconds to wait before failing (default 30)."),
});

/** Start capturing network requests/responses into the network log ring. */
const EnableNetworkLogSchema = z.object({
  type: z.literal("enable_network_log").describe("Start recording network requests and responses into the network log (keep existing entries)."),
});

/** Stop capturing network activity (existing entries are kept). */
const DisableNetworkLogSchema = z.object({
  type: z.literal("disable_network_log").describe("Stop recording network activity. Existing entries are kept."),
});

/** Get the recorded network requests/responses (up to 500 most recent). */
const GetNetworkLogSchema = z.object({
  type: z.literal("get_network_log").describe("Get the recorded network requests/responses as JSON (up to 500 most recent)."),
});

/** Empty the network log. */
const ClearNetworkLogSchema = z.object({
  type: z.literal("clear_network_log").describe("Clear the recorded network log."),
});

/** Get AND clear the network log in one step. */
const GetclearNetworkLogSchema = z.object({
  type: z.literal("getclear_network_log").describe("Get AND clear the recorded network log in one step (entries are returned, then the log is emptied)."),
});

/** Start capturing page console.log/error/warn/info calls into the console log ring. */
const EnableConsoleLogSchema = z.object({
  type: z.literal("enable_console_log").describe("Start recording the page's console.log/error/warn/info calls (keep existing entries)."),
});

/** Stop capturing console calls (existing entries are kept). */
const DisableConsoleLogSchema = z.object({
  type: z.literal("disable_console_log").describe("Stop recording console calls. Existing entries are kept."),
});

/** Get the recorded console calls (up to 500 most recent). */
const GetConsoleLogSchema = z.object({
  type: z.literal("get_console_log").describe("Get the recorded console calls as JSON (up to 500 most recent)."),
});

/** Empty the console log. */
const ClearConsoleLogSchema = z.object({
  type: z.literal("clear_console_log").describe("Clear the recorded console log."),
});

/** Get AND clear the console log in one step. */
const GetclearConsoleLogSchema = z.object({
  type: z.literal("getclear_console_log").describe("Get AND clear the recorded console log in one step (entries are returned, then the log is emptied)."),
});

/** Scroll the page until the given text becomes visible. */
const FindTextSchema = z.object({
  type: z.literal("find_text").describe("Scroll the page until the given text becomes visible."),
  text: boundedText(MAX_FREE_TEXT_CHARS).describe("The text to search for and scroll to."),
});

/** Extract specific information from the full page text using a query. */
const ExtractSchema = z.object({
  type: z.literal("extract").describe("Extract specific information from the full page text using a query. Use when the info you need is not in the interactive elements list."),
  query: boundedText(MAX_FREE_TEXT_CHARS).describe("A specific question describing what to extract from the page."),
});

/** Finish the task. MUST be the only action in its step. */
const DoneSchema = z.object({
  type: z.literal("done").describe("Finish the task. MUST be the ONLY action in the step."),
  text: z.preprocess(
    (v) => (v === null || v === undefined ? "" : v),
    z.coerce.string().max(MAX_FREE_TEXT_CHARS),
  ).describe("A summary of what was accomplished, including all results the user asked for."),
  success: flexibleBoolean.default(false).describe("true ONLY if the entire user request is fully complete; false otherwise."),
});

/** Search the web using a search engine. Page-changing — put LAST. */
export const SearchSchema = z.object({
  type: z.literal("search").describe("Search the web using a search engine. Page-changing — put LAST."),
  query: boundedText(MAX_FREE_TEXT_CHARS).describe("The search query."),
  engine: z.enum(["google", "bing", "duckduckgo", "yahoo", "baidu"]).optional().default("duckduckgo").describe("Search engine: duckduckgo, google, bing, yahoo, or baidu (default duckduckgo)."),
});

/** Upload a file to a file input element. */
const UploadFileSchema = z.object({
  type: z.literal("upload_file").describe("Upload a file to a file input element."),
  index: z.coerce.number().int().min(1).describe("The [index] of the file input element."),
  path: boundedText(MAX_SHORT_TEXT_CHARS).describe("The path to the file to upload."),
});

/** Take a screenshot of the current page. */
const ScreenshotSchema = z.object({
  type: z.literal("screenshot").describe("Take a screenshot of the current page."),
  file_name: z.string().max(MAX_SHORT_TEXT_CHARS).optional().describe("Optional filename for the screenshot."),
});

/** Ask the main multimodal model to inspect one fresh viewport frame next turn. */
const InspectVisualSchema = z.object({
  type: z.literal("inspect_visual").describe("Capture the current viewport and attach it once to your next turn. Use only when pixels add material evidence that DOM/accessibility text cannot provide: images, charts, canvas, maps, layout, occlusion, or visual ambiguity. Do not use routinely."),
  reason: boundedText(MAX_SHORT_TEXT_CHARS).describe("Briefly state what visual evidence you need."),
});

/** Save the current page as a PDF. */
const SaveAsPdfSchema = z.object({
  type: z.literal("save_as_pdf").describe("Save the current page as a PDF."),
  file_name: z.string().max(MAX_SHORT_TEXT_CHARS).optional().describe("Optional filename for the PDF."),
});

/** List all options of a `<select>` dropdown element. */
const DropdownOptionsSchema = z.object({
  type: z.literal("dropdown_options").describe("Get all options of a <select> dropdown element."),
  index: z.coerce.number().int().min(1).describe("The [index] of the <select> element."),
});

/** Continue reading a truncated page snapshot from the given char offset. */
const PageNextSchema = z.object({
  type: z.literal("page_next").describe("Continue reading a truncated page snapshot. Use the offset from the snapshot's 'Call page_next with offset=N' marker to resume from where it stopped."),
  offset: z.coerce.number().int().min(0).optional().describe("Char offset to resume from (default 0 = first window)."),
});

/** List files the agent has downloaded this session. */
const ListDownloadsSchema = z.object({
  type: z.literal("list_downloads").describe("List the files downloaded during this session (name, size, mime). Read-only."),
});

/** Search for text/regex on the current page (instant, free). */
const SearchPageSchema = z.object({
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
  // null/'' map to the default 50 (preprocess BEFORE coerce); anything else
  // unparseable (e.g. "abc") is still rejected. `.optional().default(50)` alone
  // would let null/'' fall through to coerce → NaN → invalid_type.
  max_results: z.preprocess(
    (v) => (v === null || v === "" ? 50 : v),
    z.coerce.number().int().min(1).max(200),
  ).optional().default(50).describe("Max results to return (default 50, capped at 200)."),
});

/** List interactive elements with pixel coordinates (port of get_elements.js). */
export const ListInteractiveSchema = z.object({
  type: z.literal("list_interactive").describe("List interactive elements (links, buttons, inputs, selects, textareas, [role=…], [onclick], [tabindex], label[for], summary, [contenteditable]) with pixel coordinates (x/y/w/h) + unique CSS selectors — CDP click targets without a vision pass."),
  visible_only: flexibleBoolean.optional().default(false).describe("If true, only return elements overlapping the current viewport."),
  max_results: z.preprocess(
    (v) => (v === null || v === "" ? 50 : v),
    z.coerce.number().int().min(1).max(200),
  ).optional().default(50).describe("Max results to return (default 50, capped at 200)."),
});

/** Read computed CSS style values of an element (instant, free). */
const GetComputedStyleSchema = z.object({
  type: z.literal("get_computed_style").describe("Get computed CSS style values of an element (instant, free)."),
  index: z.coerce.number().int().min(1).describe("The [index] of the element."),
  properties: z
    .array(z.coerce.string().regex(/^[a-zA-Z-]{1,64}$/).describe("CSS property name (camelCase or kebab-case)."))
    .min(1)
    .max(50)
    .describe("CSS properties to read (max 50)."),
});

/** Read page-level metadata (URL, title, state, dimensions) as JSON (instant, free). */
const GetPageInfoSchema = z.object({
  type: z.literal("get_page_info").describe("Get the current page URL, title, state, and viewport/document dimensions as JSON (instant, free)."),
});

/** Execute arbitrary JavaScript on the page. Page-changing — put LAST. */
const EvaluateSchema = z.object({
  type: z.literal("evaluate").describe("Execute JavaScript on the page. Page-changing — put LAST. Use only when no other action works."),
  code: boundedText(MAX_CODE_CHARS).describe("JavaScript code to execute (wrapped in an IIFE). Only browser APIs, no Node.js."),
});

/** Run a multi-step YAML/JSON script (parsed + validated, steps execute as actions). */
const RunScriptSchema = z.object({
  type: z.literal("run_script").describe("Run a multi-step YAML or JSON script (parsed and validated before execution; each step runs like an ordinary action). Page-changing — put LAST."),
  script: boundedText(MAX_FREE_TEXT_CHARS).describe("YAML or JSON script text: {name?, on_error?: 'stop'|'continue', steps: [...]} with action steps + if/repeat/while control nodes."),
});

/** Hover over an element to trigger menus or tooltips. */
const HoverSchema = z.object({
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
  // Plain coerce like `pages`: null/'' → 0 (tolerated instead of a parse
  // failure); non-numeric strings are still rejected.
  hold_ms: z.coerce.number().int().min(0).max(60000).optional().default(1500).describe("How long to hold the mouse button down, in milliseconds (default 1500, capped at 60000)."),
  delay_ms: z.coerce.number().int().min(0).max(60000).optional().default(0).describe("Optional pre-press hover-settle delay, in milliseconds (default 0, capped at 60000)."),
});

/** Ask the user a question when stuck or needing a decision. */
export const AskHumanSchema = z.object({
  type: z.literal("ask_human").describe("Ask the user a question. Use when stuck, confused, or needing a decision."),
  question: boundedText(MAX_FREE_TEXT_CHARS).describe("The question to ask the user."),
  mode: z.enum(["input", "password"]).optional().default("input").describe("Input mode: 'input' (default, visible text) or 'password' (masked — use for credentials, API keys, tokens)."),
});

/** Pause the agent and let the user perform an action manually. */
const TakeoverSchema = z.object({
  type: z.literal("takeover").describe("Pause the agent and let the user perform an action manually. Use for logins, payments, captchas, or any sensitive action the agent should not perform."),
  reason: boundedText(MAX_FREE_TEXT_CHARS).describe("Why the user needs to take over (e.g. 'Login required', 'Payment form detected', 'CAPTCHA present')."),
});

/** Verify that the last action had the expected effect. */
const VerifySchema = z.object({
  type: z.literal("verify").describe("Verify that the last action had the expected effect. Use after clicks that should change the page, form submissions, or any action where success is uncertain."),
  expectation: boundedText(MAX_FREE_TEXT_CHARS).describe("What you expect to see if the action succeeded (e.g. 'success message visible', 'new page loaded', 'form cleared')."),
});

/** Load full instructions for a domain skill. */
const LoadSkillSchema = z.object({
  type: z.literal("load_skill").describe("Load full instructions for a domain skill. Use when you need site-specific tips for the current page."),
  name: boundedText(MAX_FREE_TEXT_CHARS).describe("The skill name (from the <available_skills> list)."),
});

/** Accept the currently-open JavaScript dialog (alert / confirm / prompt). */
const AlertAcceptSchema = z.object({
  type: z.literal("alert_accept").describe("Accept the currently-open JS dialog (alert/confirm/prompt). Returns failure if no dialog is open."),
});

/** Dismiss the currently-open JavaScript dialog (alert / confirm / prompt). */
const AlertDismissSchema = z.object({
  type: z.literal("alert_dismiss").describe("Dismiss the currently-open JS dialog (alert/confirm/prompt). Returns failure if no dialog is open."),
});

/** Get the text of the currently-open JavaScript dialog. */
const AlertGetTextSchema = z.object({
  type: z.literal("alert_get_text").describe("Get the text of the currently-open JS dialog. Returns empty string if no dialog is open."),
});

/** Queue `text` to be returned by the next `window.prompt()` call. */
const AlertSendKeysSchema = z.object({
  type: z.literal("alert_send_keys").describe("Stage text to be returned by the NEXT window.prompt() call. window.prompt is synchronous, so once a prompt has fired the page already received the auto-dismiss override's empty-string return — there is no way to retroactively deliver text. Call this BEFORE triggering the action that opens the prompt so the staged text reaches the page. When no dialog is open the text is staged (success); returns failure for non-prompt dialogs (alert/confirm)."),
  text: boundedText(MAX_FREE_TEXT_CHARS).describe("The text to stage for the next prompt dialog."),
});

/** Run local vision detection (LFM2.5-VL-450M) on the current screenshot. */
const DetectVisualSchema = z.object({
  type: z.literal("detect_visual").describe("Run local vision detection on the current screenshot to find UI elements that aren't in the DOM tree (Canvas, WebGL, custom widgets, image-based buttons). Returns [v1], [v2] etc. entries you can click with {\"type\":\"click\",\"index\":\"v1\"}. Use ONLY when you can see something visually on the page but can't find it in the elements list. Takes 2-5 seconds. Only available when Local Vision Assistant is enabled in AI Adaptive mode."),
  query: boundedText(MAX_FREE_TEXT_CHARS).describe("What you're looking for (e.g. 'submit button', 'login form', 'canvas dropdown')."),
});

/** Detect anti-bot challenge widgets (Turnstile, reCAPTCHA, hCaptcha, …). */
const DetectChallengeSchema = z.object({
  type: z.literal("detect_challenge").describe("Detect anti-bot challenge widgets on the page (Cloudflare Turnstile, reCAPTCHA, hCaptcha, Friendly Captcha, Altcha, AWS WAF, Arkose, Geetest). Read-only — no DOM mutation and no network requests. Optionally scrolls the first detected widget into view."),
  scroll_into_view: z.boolean().optional().describe("If true, scroll the first visible detected challenge into view (centered). Default false."),
});

/** List the browser tabs the agent can navigate to. Read-only. */
const ListTabsSchema = z.object({
  type: z.literal("list_tabs").describe("List the open browser tabs (URL + active state). Read-only. The index is the tab ID you can switch to or close."),
});

/** Read cookies for the current site or the given URLs. Read-only. Cookie
 *  values are redacted before the payload reaches the model (session tokens
 *  are credentials). */
const GetCookiesSchema = z.object({
  type: z.literal("get_cookies").describe("Read cookies (name, domain, path, secure, httpOnly, sameSite, expiry, session, hostOnly; VALUES ARE REDACTED). Read-only."),
  urls: z.array(z.string().regex(/^https?:\/\//i)).max(20).optional().describe("Optional URLs to filter cookies by (http/https only). Defaults to all cookies."),
});

/** Write a cookie. The effective URL is subject to the domain allow/blocklist. */
const SetCookieSchema = z
  .object({
    type: z.literal("set_cookie").describe("Write a cookie for url or domain. Requires url OR domain; the effective URL must pass the domain policy."),
    url: z.string().regex(/^https?:\/\//i).optional().describe("URL to write the cookie for."),
    domain: z.string().optional().describe("Domain to write the cookie for (use url OR domain)."),
    name: boundedText(MAX_SHORT_TEXT_CHARS).describe("Cookie name."),
    value: boundedText(MAX_FREE_TEXT_CHARS).describe("Cookie value."),
    path: z.string().optional().describe("Cookie path (defaults to the URL's path)."),
    secure: z.boolean().optional().describe("Whether the cookie is restricted to HTTPS."),
    httpOnly: z.boolean().optional().describe("Whether the cookie is inaccessible to page scripts."),
    sameSite: z.enum(["no_restriction", "lax", "strict"]).optional().describe("SameSite policy."),
    expirationDate: z.number().optional().describe("Expiration as a Unix timestamp in seconds (omit for a session cookie)."),
  })
  .refine((d) => d.url !== undefined || d.domain !== undefined, {
    message: "set_cookie requires url or domain",
  });

/** Delete cookies. Destructive — requires an explicit opt-in (≥1 url or all:true). */
const DeleteCookiesSchema = z
  .object({
    type: z.literal("delete_cookies").describe("Delete cookies. Requires at least one url OR the explicit all:true opt-in (deleting every cookie is destructive)."),
    urls: z.array(z.string().regex(/^https?:\/\//i)).max(20).optional().describe("URLs to delete cookies for (http/https only)."),
    all: z.boolean().optional().describe("EXPLICIT opt-in to delete every cookie. Never inferred from an empty/absent urls list."),
  })
  .refine((d) => d.all === true || (Array.isArray(d.urls) && d.urls.length > 0), {
    message: "delete_cookies requires at least one url or explicit all:true",
  });

/** Read the extension's own key/value storage. Read-only. */
const GetStorageSchema = z.object({
  type: z.literal("get_storage").describe("Read the extension's key/value storage (use for cross-step memory). Read-only."),
  storage_type: z.enum(["local", "session"]).optional().default("local").describe("Which storage area to read (default local)."),
});

/** Write a value to the extension's key/value storage. */
const SetStorageSchema = z.object({
  type: z.literal("set_storage").describe("Write a JSON-serializable value to the extension's key/value storage (use for cross-step memory)."),
  storage_type: z.enum(["local", "session"]).optional().default("local").describe("Which storage area to write (default local)."),
  key: boundedText(MAX_SHORT_TEXT_CHARS).describe("Storage key."),
  value: z.unknown().describe("Value to store (must be JSON-serializable)."),
});

/** Clear the extension's key/value storage. Destructive — requires an explicit opt-in. */
const ClearStorageSchema = z
  .object({
    type: z.literal("clear_storage").describe("Clear the extension's key/value storage. Requires a keys list OR the explicit all:true opt-in (a whole-area wipe is destructive and is never inferred from an empty/absent keys list)."),
    storage_type: z.enum(["local", "session"]).optional().default("local").describe("Which storage area to clear (default local)."),
    keys: z.array(boundedText(MAX_SHORT_TEXT_CHARS)).max(100).optional().describe("Exact keys to remove."),
    all: z.boolean().optional().describe("EXPLICIT opt-in to clear the entire storage area."),
  })
  .refine((d) => d.all === true || (Array.isArray(d.keys) && d.keys.length > 0), {
    message: "clear_storage requires at least one key or explicit all:true",
  });

// ─── Union + helpers ────────────────────────────────────────────────────────

/** Discriminated union of all action schemas (60 actions). */
export const ActionSchema = z.discriminatedUnion("type", [
  ClickSchema,
  InputSchema,
  SelectDropdownSchema,
  ScrollSchema,
  ScrollToBottomSchema,
  SendKeysSchema,
  NavigateSchema,
  SwitchTabSchema,
  CloseTabSchema,
  GoBackSchema,
  WaitSchema,
  WaitForElementSchema,
  WaitForTextSchema,
  WaitForUrlSchema,
  WaitForNetworkIdleSchema,
  EnableNetworkLogSchema,
  DisableNetworkLogSchema,
  GetNetworkLogSchema,
  ClearNetworkLogSchema,
  GetclearNetworkLogSchema,
  EnableConsoleLogSchema,
  DisableConsoleLogSchema,
  GetConsoleLogSchema,
  ClearConsoleLogSchema,
  GetclearConsoleLogSchema,
  FindTextSchema,
  ExtractSchema,
  DoneSchema,
  SearchSchema,
  UploadFileSchema,
  ScreenshotSchema,
  InspectVisualSchema,
  SaveAsPdfSchema,
  DropdownOptionsSchema,
  PageNextSchema,
  ListDownloadsSchema,
  SearchPageSchema,
  FindElementsSchema,
  ListInteractiveSchema,
  GetComputedStyleSchema,
  GetPageInfoSchema,
  EvaluateSchema,
  RunScriptSchema,
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
  DetectChallengeSchema,
  ListTabsSchema,
  GetCookiesSchema,
  SetCookieSchema,
  DeleteCookiesSchema,
  GetStorageSchema,
  SetStorageSchema,
  ClearStorageSchema,
]);

/** Schema for the navigator's per-step structured output. */
export const AgentOutputSchema = z.object({
  thinking: z.string().default("").describe("Your step-by-step reasoning about the current state and what to do next."),
  evaluation_previous_goal: z.string().default("").describe("One sentence: did your last action succeed, fail, or is uncertain? End with 'Verdict: Success' or 'Verdict: Failure'."),
  memory: z.string().default("").describe("1-3 sentences tracking progress (what's done, what's next, counts)."),
  next_goal: z.string().default("").describe("One clear sentence stating the immediate goal of this step."),
  action: z
    .array(ActionSchema)
    .min(1)
    .max(50)
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
