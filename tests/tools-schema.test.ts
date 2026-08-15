/**
 * null/'' tolerance for the LLM-visible numeric fields of
 * WaitSchema / FindElementsSchema / PressAndHoldSchema.
 *
 * The LLM can emit `null` or `""` for optional numeric fields. Documented
 * behavior: those inputs must be tolerated (coerced like `pages`, or mapped
 * to the field default) instead of failing the whole action parse — a parse
 * failure costs a retry nudge, and in llm-direct structured mode it is a
 * hard failure. Other invalid types (non-numeric strings, objects) must
 * still be rejected.
 */

import { describe, test, expect } from "vitest";
import { WaitSchema, FindElementsSchema, PressAndHoldSchema } from "../src/lib/agent/tools/schema";
import { actionListForPrompt } from "../src/lib/agent/tools/schema-utils";

describe("WaitSchema.seconds", () => {
  test("accepts null and '' like `pages` (coerced to 0), undefined → default 3", () => {
    expect(WaitSchema.shape.seconds.safeParse(null).success).toBe(true);
    expect(WaitSchema.shape.seconds.safeParse("").success).toBe(true);
    expect(WaitSchema.parse({ type: "wait" }).seconds).toBe(3);
  });

  test("rejects other invalid types", () => {
    expect(WaitSchema.shape.seconds.safeParse("abc").success).toBe(false);
    expect(WaitSchema.shape.seconds.safeParse({}).success).toBe(false);
  });
});

describe("FindElementsSchema.max_results", () => {
  test("accepts null and '' mapped to the default 50, undefined → default 50", () => {
    expect(FindElementsSchema.shape.max_results.safeParse(null).success).toBe(true);
    expect(FindElementsSchema.shape.max_results.safeParse(null).data).toBe(50);
    expect(FindElementsSchema.shape.max_results.safeParse("").success).toBe(true);
    expect(FindElementsSchema.shape.max_results.safeParse("").data).toBe(50);
    expect(FindElementsSchema.parse({ type: "find_elements", selector: ".x" }).max_results).toBe(50);
  });

  test("rejects other invalid types", () => {
    expect(FindElementsSchema.shape.max_results.safeParse("abc").success).toBe(false);
    expect(FindElementsSchema.shape.max_results.safeParse({}).success).toBe(false);
  });
});

describe("PressAndHoldSchema.hold_ms", () => {
  test("accepts null and '' like `pages` (coerced to 0), undefined → default 1500", () => {
    expect(PressAndHoldSchema.shape.hold_ms.safeParse(null).success).toBe(true);
    expect(PressAndHoldSchema.shape.hold_ms.safeParse("").success).toBe(true);
    expect(PressAndHoldSchema.parse({ type: "press_and_hold", index: 1 }).hold_ms).toBe(1500);
  });

  test("rejects other invalid types", () => {
    expect(PressAndHoldSchema.shape.hold_ms.safeParse("abc").success).toBe(false);
    expect(PressAndHoldSchema.shape.hold_ms.safeParse({}).success).toBe(false);
  });
});

describe("actionListForPrompt capability gating", () => {
  test("a gated listing (enabledActions provided) omits cookies/storage names and keeps core + enabled + the adaptive vision pair", () => {
    const gated = actionListForPrompt(5, "adaptive", new Set(["list_tabs"]));
    // Non-core actions NOT in the enabled set are omitted from the listing.
    for (const name of ["get_cookies", "set_cookie", "delete_cookies", "get_storage", "set_storage", "clear_storage"]) {
      expect(gated, name).not.toContain(`- ${name}`);
    }
    // Core actions always render.
    for (const name of ["click", "input", "select_dropdown", "scroll", "navigate", "wait", "extract", "search_page", "done", "ask_human"]) {
      expect(gated, name).toContain(`- ${name}`);
    }
    // The enabled action renders (with its exact param contract, no prose).
    expect(gated).toContain("- list_tabs | params: { (none) }");
    // The vision pair renders in adaptive mode regardless of the enabled set.
    expect(gated).toContain("- detect_visual");
    expect(gated).toContain("- inspect_visual");
    // The header reflects maxActions, unchanged by gating.
    expect(gated).toContain("You may output 1 to 5 actions per step.");
  });

  test("the default call (no third arg) renders the full set — byte-identical to the pre-gating output", () => {
    // Pinned from the pre-gating implementation (2026-08-15). Any drift in the
    // default path — reordering, prose, tags, params — fails this test.
    const pinned = `You may output 1 to 5 actions per step. Available actions:
- click — Click an interactive element by index. | params: { index: number }
- input — Type text into an input/textarea. | params: { index: number, text: string, clear?: boolean (default true = replace) }
- select_dropdown — Choose an option in a <select>. | params: { index: number, text?: string OR option_index?: number }
- scroll — Scroll the page. | params: { down?: boolean (default true), pages?: number (default 1) }
- scroll_to_bottom — Scroll to the very bottom, then restore the viewport to the top. | params: { delay_seconds?: number (default 0.4) }
- send_keys — Press a key (Enter, Escape, Tab...). | params: { keys: string }
- navigate [page-changing — put last] — Go to a URL (optionally new tab). | params: { url: string, new_tab?: boolean (default false) }
- switch_tab [page-changing — put last] — Switch to another open tab. | params: { tab_id: number }
- close_tab [page-changing — put last] — Close a tab. | params: { tab_id: number }
- go_back [page-changing — put last] — Browser back button. | params: { (none) }
- wait — Wait for the page to settle. | params: { seconds?: number (default 3) }
- wait_for_element | params: { selector: string, state?: 'visible'|'hidden'|'attached'|'detached' (default visible), timeout_seconds?: number (default 30) }
- wait_for_text | params: { text: string, timeout_seconds?: number (default 30) }
- wait_for_url | params: { url: string, timeout_seconds?: number (default 30) }
- wait_for_network_idle | params: { timeout_seconds?: number (default 30) }
- enable_network_log | params: { (none) }
- disable_network_log | params: { (none) }
- get_network_log | params: { (none) }
- clear_network_log | params: { (none) }
- getclear_network_log | params: { (none) }
- enable_console_log | params: { (none) }
- disable_console_log | params: { (none) }
- get_console_log | params: { (none) }
- clear_console_log | params: { (none) }
- getclear_console_log | params: { (none) }
- find_text — Scroll until text is visible. | params: { text: string }
- extract — Extract info from page text via a query. | params: { query: string }
- done [must be the only action] — Finish the task. | params: { text: string (summary), success: boolean }
- search [page-changing — put last] — Search the web (DuckDuckGo/Google/Bing). | params: { query: string, engine?: 'duckduckgo'|'google'|'bing'|'yahoo'|'baidu' }
- research [must be the only action] — Research the web in the fast headless Lightpanda browser with the same AI — returns a synthesized answer for fresh/multi-site questions. Runs outside the current tab. | params: { query: string }
- upload_file | params: { index: number, path: string }
- screenshot | params: { file_name?: string }
- inspect_visual [must be the only action] — Attach one fresh viewport screenshot to the next model turn when pixels materially help (images, charts, canvas, layout, occlusion, or ambiguity). Never call routinely. | params: { reason: string }
- save_as_pdf | params: { file_name?: string }
- dropdown_options | params: { index: number }
- page_next | params: { offset?: number (default 0) }
- list_downloads | params: { (none) }
- search_page — Search for text/pattern on the page (instant, free). | params: { pattern: string, regex?: boolean, case_sensitive?: boolean }
- find_elements — Find elements by CSS selector (instant, free). | params: { selector: string, attributes?: string[], max_results?: number }
- list_interactive — List interactive elements (links, buttons, inputs, selects, textareas, [role=…], [onclick], [tabindex], label[for], summary, [contenteditable]) with pixel coordinates + unique CSS selectors for direct CDP clicks without a vision pass. | params: { visible_only?: boolean (default false), max_results?: number (default 50, cap 200) }
- get_computed_style | params: { index: number, properties: string[] (max 50, camelCase or kebab-case) }
- get_page_info | params: { (none) }
- evaluate [page-changing — put last] | params: { code: string }
- run_script [page-changing — put last] | params: { script: string (YAML/JSON text) }
- hover | params: { index: number }
- press_and_hold [page-changing — put last] | params: { index: number, hold_ms?: number (default 1500), delay_ms?: number (default 0) }
- ask_human [must be the only action] — Ask the user a question when stuck. | params: { question: string, mode?: 'input'|'password' (default 'input') }
- takeover [must be the only action] — Pause for user to act manually. | params: { reason: string }
- verify — Verify the last action had the expected effect. | params: { expectation: string }
- load_skill — Load full instructions for a domain skill. | params: { name: string }
- alert_accept | params: { (none) }
- alert_dismiss | params: { (none) }
- alert_get_text | params: { (none) }
- alert_send_keys | params: { text: string }
- detect_visual [must be the only action] — Run local vision detection to find UI elements not in the DOM (Canvas, WebGL, custom widgets). Returns [v1], [v2] etc. that you can click. Use ONLY when you can see something visually but can't find it in the elements list. | params: { query: string }
- detect_challenge | params: { scroll_into_view?: boolean (default false) }
- list_tabs | params: { (none) }
- get_cookies | params: { urls?: string[] (http/https) }
- set_cookie | params: { url?: string | domain?: string, name: string, value: string, path?/secure?/httpOnly?/sameSite?/expirationDate? }
- delete_cookies [page-changing — put last] | params: { urls?: string[] (http/https) | all?: boolean }
- get_storage | params: { storage_type?: 'local'|'session' (default 'local') }
- set_storage | params: { storage_type?: 'local'|'session', key: string, value: unknown }
- clear_storage | params: { storage_type?: 'local'|'session', keys?: string[] | all?: boolean }`;
    expect(actionListForPrompt(5, "adaptive")).toBe(pinned);
  });
});
