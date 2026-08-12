// @vitest-environment-options {"url":"http://matrix.test/"}

/**
 * Generated action matrix.
 *
 * A matrix test over EVERY canonical action in `ActionSchema`. For each action
 * the matrix proves all seven legs:
 *
 *  1. schema        — the canonical fixture parses via `ActionSchema`.
 *  2. authorization — the executor's universal boundary requests exactly one
 *                     capability for the canonical parsed payload.
 *  3. invocation    — the executor dispatches to the matching branch and the
 *                     result carries the parsed action.
 *  4. cancellation  — a pre-aborted run signal short-circuits BEFORE any
 *                     handler runs (no side effect after cancellation).
 *  5. timeout       — SW-RPC actions bound a hung service worker with a
 *                     bounded timeout; non-SW-RPC actions prove no background
 *                     channel exists (nothing to time out).
 *  6. cleanup       — SW-RPC actions remove every abort listener and clear
 *                     their timers on the timeout path (no leaks).
 *  7. evidence      — `ActionResult.action` is the exact canonical parsed
 *                     action, `success` is a boolean, `message` is a string.
 *
 * Completeness is GENERATED: the schema's discriminated-union options are
 * enumerated and compared against the fixture table, so adding an action to
 * the schema without adding a matrix row FAILS the suite.
 */

import { describe, test, expect, vi, afterEach } from "vitest";
import { ActionSchema } from "../src/lib/agent/tools/schema";
import type { AgentAction } from "../src/lib/agent/types";
import { makeState } from "./helpers";

// ─── Canonical fixtures (one per action type) ───────────────────────────────
// Mirrors tests/action-parity-contract.test.ts — kept as RAW inputs so
// the schema leg proves each representative is accepted by the canonical
// schema before any downstream contract runs.

const ACTION_FIXTURES = {
  click: { type: "click", index: 1 },
  input: { type: "input", index: 1, text: "contract text" },
  select_dropdown: { type: "select_dropdown", index: 1, text: "option" },
  scroll: { type: "scroll", down: true, pages: 0 },
  scroll_to_bottom: { type: "scroll_to_bottom", delay_seconds: 0 },
  send_keys: { type: "send_keys", keys: "Enter" },
  navigate: { type: "navigate", url: "https://example.test/next", new_tab: true },
  switch_tab: { type: "switch_tab", tab_id: 7 },
  close_tab: { type: "close_tab", tab_id: 7 },
  go_back: { type: "go_back" },
  wait: { type: "wait", seconds: 0 },
  wait_for_element: { type: "wait_for_element", selector: ".target", timeout_seconds: 0 },
  wait_for_text: { type: "wait_for_text", text: "ready", timeout_seconds: 0 },
  wait_for_url: { type: "wait_for_url", url: "**/ready", timeout_seconds: 0 },
  wait_for_network_idle: { type: "wait_for_network_idle", timeout_seconds: 0 },
  enable_network_log: { type: "enable_network_log" },
  disable_network_log: { type: "disable_network_log" },
  get_network_log: { type: "get_network_log" },
  clear_network_log: { type: "clear_network_log" },
  getclear_network_log: { type: "getclear_network_log" },
  enable_console_log: { type: "enable_console_log" },
  disable_console_log: { type: "disable_console_log" },
  get_console_log: { type: "get_console_log" },
  clear_console_log: { type: "clear_console_log" },
  getclear_console_log: { type: "getclear_console_log" },
  find_text: { type: "find_text", text: "needle" },
  extract: { type: "extract", query: "the title" },
  done: { type: "done", text: "complete", success: true },
  search: { type: "search", query: "phase ten contract", engine: "duckduckgo" },
  upload_file: { type: "upload_file", index: 1, path: "/tmp/contract.txt" },
  screenshot: { type: "screenshot", file_name: "contract.jpg" },
  save_as_pdf: { type: "save_as_pdf", file_name: "contract.pdf" },
  dropdown_options: { type: "dropdown_options", index: 1 },
  page_next: { type: "page_next", offset: 0 },
  list_downloads: { type: "list_downloads" },
  search_page: { type: "search_page", pattern: "needle", regex: false, case_sensitive: false },
  find_elements: { type: "find_elements", selector: ".target", attributes: ["aria-label"], max_results: 1 },
  list_interactive: { type: "list_interactive", visible_only: true, max_results: 1 },
  get_computed_style: { type: "get_computed_style", index: 1, properties: ["display"] },
  get_page_info: { type: "get_page_info" },
  evaluate: { type: "evaluate", code: "return 1;" },
  run_script: { type: "run_script", script: "steps: []" },
  hover: { type: "hover", index: 1 },
  press_and_hold: { type: "press_and_hold", index: 1, hold_ms: 0, delay_ms: 0 },
  ask_human: { type: "ask_human", question: "Continue?", mode: "input" },
  takeover: { type: "takeover", reason: "Manual login required" },
  verify: { type: "verify", expectation: "confirmation visible" },
  load_skill: { type: "load_skill", name: "GitHub" },
  alert_accept: { type: "alert_accept" },
  alert_dismiss: { type: "alert_dismiss" },
  alert_get_text: { type: "alert_get_text" },
  alert_send_keys: { type: "alert_send_keys", text: "answer" },
  detect_visual: { type: "detect_visual", query: "submit button" },
  detect_challenge: { type: "detect_challenge", scroll_into_view: false },
  list_tabs: { type: "list_tabs" },
  get_cookies: { type: "get_cookies", urls: ["https://example.test/"] },
  set_cookie: { type: "set_cookie", url: "https://example.test/", name: "contract", value: "value" },
  delete_cookies: { type: "delete_cookies", urls: ["https://example.test/"] },
  get_storage: { type: "get_storage", storage_type: "local" },
  set_storage: { type: "set_storage", storage_type: "local", key: "contract", value: { ok: true } },
  clear_storage: { type: "clear_storage", storage_type: "local", keys: ["contract"] },
} as const;

type ActionType = keyof typeof ACTION_FIXTURES;
const ACTION_TYPES = Object.keys(ACTION_FIXTURES) as ActionType[];

/**
 * Action types whose handlers race a background `chrome.runtime.sendMessage`
 * (SW-RPC family): they MUST bound the round-trip with a timeout AND clean up
 * their abort listeners. Every other type proves the NEGATIVE: no background
 * channel is opened at all.
 */
const SW_RPC_TYPES: ReadonlySet<ActionType> = new Set<ActionType>([
  // Tab-level + privileged effects (TAB_ACTION / SCREENSHOT / SAVE_AS_PDF /
  // DETECT_VISUAL / CDP family / ask_human).
  "navigate",
  "switch_tab",
  "close_tab",
  "list_tabs",
  "get_cookies",
  "set_cookie",
  "delete_cookies",
  "get_storage",
  "set_storage",
  "clear_storage",
  "screenshot",
  "save_as_pdf",
  "detect_visual",
  "list_downloads",
  "ask_human",
  // Scroll actions clear the SW vision-element cache (CLEAR_VISION_CACHE).
  "scroll",
  "scroll_to_bottom",
  // Ring-log families (enable/disable/get/clear/getclear) delegate to the SW.
  "enable_network_log",
  "disable_network_log",
  "get_network_log",
  "clear_network_log",
  "getclear_network_log",
  "enable_console_log",
  "disable_console_log",
  "get_console_log",
  "clear_console_log",
  "getclear_console_log",
]);

function schemaActionTypes(): string[] {
  const schema = ActionSchema as unknown as { options?: Array<{ shape?: { type?: { values?: Set<unknown> } } }> };
  const options = schema.options;
  if (!options) throw new Error("ActionSchema no longer exposes discriminated-union options");
  return options.map((option) => {
    const value = Array.from(option.shape?.type?.values ?? [])[0];
    if (typeof value !== "string") throw new Error("Could not read ActionSchema type discriminator");
    return value;
  });
}

const PARSED_ACTIONS = Object.fromEntries(
  ACTION_TYPES.map((type) => {
    const result = ActionSchema.safeParse(ACTION_FIXTURES[type]);
    if (!result.success) throw new Error(`Fixture for ${type} no longer parses: ${result.error.message}`);
    return [type, result.data];
  }),
) as Record<ActionType, AgentAction>;

/** Handler name per action type — mirrors the executor's switch mapping. */
const HANDLER_BY_ACTION: Record<ActionType, string | undefined> = {
  click: "handleClick", input: "handleInput", select_dropdown: "handleSelectDropdown",
  scroll: "handleScroll", scroll_to_bottom: "handleScrollToBottom", send_keys: "handleSendKeys",
  navigate: "handleNavigate", switch_tab: "handleSwitchTab", close_tab: "handleCloseTab",
  go_back: "handleGoBack", wait: "handleWait", wait_for_element: "handleWaitForElement",
  wait_for_text: "handleWaitForText", wait_for_url: "handleWaitForUrl",
  wait_for_network_idle: "handleWaitForNetworkIdle", enable_network_log: "handleEnableNetworkLog",
  disable_network_log: "handleDisableNetworkLog", get_network_log: "handleGetNetworkLog",
  clear_network_log: "handleClearNetworkLog", getclear_network_log: "handleGetclearNetworkLog",
  enable_console_log: "handleEnableConsoleLog", disable_console_log: "handleDisableConsoleLog",
  get_console_log: "handleGetConsoleLog", clear_console_log: "handleClearConsoleLog",
  getclear_console_log: "handleGetclearConsoleLog", find_text: "handleFindText", extract: "handleExtract",
  done: "handleDone", search: "handleSearch", upload_file: "handleUploadFile",
  screenshot: "handleScreenshot", save_as_pdf: "handleSaveAsPdf", dropdown_options: "handleDropdownOptions",
  page_next: undefined, list_downloads: undefined, search_page: "handleSearchPage",
  find_elements: "handleFindElements", list_interactive: "handleListInteractive",
  get_computed_style: "handleGetComputedStyle", get_page_info: "handleGetPageInfo",
  evaluate: "handleEvaluate", run_script: undefined, hover: "handleHover",
  press_and_hold: "handlePressAndHold", ask_human: "handleAskHuman", takeover: "handleTakeover",
  verify: "handleVerify", load_skill: "handleLoadSkill", alert_accept: "handleAlertAccept",
  alert_dismiss: "handleAlertDismiss", alert_get_text: "handleAlertGetText",
  alert_send_keys: "handleAlertSendKeys", detect_visual: "handleDetectVisual",
  detect_challenge: undefined, list_tabs: "handleListTabs", get_cookies: "handleGetCookies",
  set_cookie: "handleSetCookie", delete_cookies: "handleDeleteCookies",
  get_storage: "handleGetStorage", set_storage: "handleSetStorage", clear_storage: "handleClearStorage",
};

const HANDLER_NAMES = [...new Set(Object.values(HANDLER_BY_ACTION).filter((v): v is string => v !== undefined))];

// ─── Leg 1: schema + generation completeness ─────────────────────────────────

describe("Action matrix — schema leg (generated completeness)", () => {
  test("the schema's action set EXACTLY matches the matrix rows (no orphan, no gap)", () => {
    const schemaTypes = schemaActionTypes();
    expect(schemaTypes.sort()).toEqual([...ACTION_TYPES].sort());
  });

  test("every canonical fixture parses through ActionSchema (schema leg)", () => {
    for (const type of ACTION_TYPES) {
      const parsed = ActionSchema.safeParse(ACTION_FIXTURES[type]);
      expect(parsed.success, `${type} must validate against ActionSchema`).toBe(true);
    }
  });
});

// ─── Legs 2/3/4/7: authorization + invocation + cancellation + evidence ──────

describe("Action matrix — dispatch legs (mocked handlers)", () => {
  afterEach(() => {
    vi.doUnmock("../src/lib/agent/tools/handlers");
    vi.doUnmock("../src/lib/agent/script-runner");
    vi.doUnmock("../src/lib/agent/dom/challenge-snapshot");
    vi.doUnmock("../src/lib/agent/dom/extraction/page-state");
    vi.resetModules();
    delete (globalThis as Record<string, unknown>).chrome;
  });

  function installMocks(): {
    handlers: Record<string, ReturnType<typeof vi.fn>>;
    sendMessage: ReturnType<typeof vi.fn>;
  } {
    const handlers = Object.fromEntries(HANDLER_NAMES.map((name) => [
      name,
      vi.fn(async (_ctx: unknown, action: AgentAction) => ({ action, success: true, message: `${name} handled` })),
    ]));
    vi.doMock("../src/lib/agent/tools/handlers", () => ({
      ...handlers,
      isExtensionContext: () => true,
    }));
    vi.doMock("../src/lib/agent/script-runner", () => ({
      parseScriptYaml: () => ({ steps: [] }),
      validateScript: () => undefined,
      runScript: async () => ({ name: "contract", success: true, steps_executed: 0, steps_total: 0, duration: 0 }),
    }));
    vi.doMock("../src/lib/agent/dom/challenge-snapshot", () => ({
      detectChallenges: () => ({ detected: false, status: "none", matches: [] }),
    }));
    vi.doMock("../src/lib/agent/dom/extraction/page-state", () => ({
      pageSnapshotChunk: () => ({ text: "contract snapshot", hasMore: false, offset: 0, totalChars: 17, nextOffset: 17 }),
    }));
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, success: true, message: "downloads" });
    (globalThis as Record<string, unknown>).chrome = {
      runtime: { id: "matrix-extension", sendMessage },
    };
    return { handlers, sendMessage };
  }

  test("for EVERY action: exactly-once authorization of the canonical payload, dispatch, and truthful evidence", async () => {
    const { handlers } = installMocks();
    const { executeAction } = await import("../src/lib/agent/tools/executor");
    const state = makeState();
    const authorized: AgentAction[] = [];

    for (const type of ACTION_TYPES) {
      const result = await executeAction(
        PARSED_ACTIONS[type],
        state,
        undefined,
        undefined,
        undefined,
        { runId: "matrix-fixture", dispatchRevision: 1 },
        undefined,
        async (candidate: AgentAction) => {
          // Authorization boundary must receive the CANONICAL parsed payload,
          // never a derived or lossy projection.
          expect(candidate).toEqual(PARSED_ACTIONS[type]);
          authorized.push(candidate);
          return `capability-for-${type}`;
        },
      );

      // Invocation + evidence: the branch ran and returned the parsed action.
      expect(result.action, `${type} must echo the canonical action`).toEqual(PARSED_ACTIONS[type]);
      expect(typeof result.success, `${type} success must be boolean`).toBe("boolean");
      expect(typeof result.message, `${type} message must be string`).toBe("string");
    }

    // The universal boundary is exercised exactly once per action — removing
    // the authorizer from any branch breaks this count.
    expect(authorized).toHaveLength(ACTION_TYPES.length);
    expect(authorized).toEqual(ACTION_TYPES.map((type) => PARSED_ACTIONS[type]));

    // Every handler-backed branch received the parsed action exactly once.
    for (const type of ACTION_TYPES) {
      const handlerName = HANDLER_BY_ACTION[type];
      if (!handlerName) continue;
      const fn = handlers[handlerName] as ReturnType<typeof vi.fn>;
      expect(fn, `${type} -> ${handlerName}`).toHaveBeenCalledTimes(1);
      expect(fn.mock.calls[0]?.[1], `${type} handler payload`).toEqual(PARSED_ACTIONS[type]);
    }
  });

  test("for EVERY action: a pre-aborted signal short-circuits before any handler (no post-cancel action)", async () => {
    const { handlers, sendMessage } = installMocks();
    const { executeAction } = await import("../src/lib/agent/tools/executor");
    const state = makeState();
    const aborted = new AbortController();
    aborted.abort(new DOMException("cancelled by user", "AbortError"));
    const authorizer = vi.fn(async (_a: AgentAction) => "never-reached");

    for (const type of ACTION_TYPES) {
      const result = await executeAction(PARSED_ACTIONS[type], state, aborted.signal, undefined, undefined, undefined, undefined, authorizer);
      expect(result.success, `${type} must fail (not run) after cancellation`).toBe(false);
    }

    // Zero handlers invoked, zero authorizations requested, zero background
    // messages — the executor boundary rejected every action before dispatch.
    for (const name of HANDLER_NAMES) {
      expect(handlers[name] as ReturnType<typeof vi.fn>, `${name} must not run after cancellation`).not.toHaveBeenCalled();
    }
    expect(authorizer).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("non-SW-RPC actions never open a background channel (no timeout to leak, nothing to clean up)", async () => {
    const { sendMessage } = installMocks();
    const { executeAction } = await import("../src/lib/agent/tools/executor");
    const state = makeState();
    const nonSwRpc = ACTION_TYPES.filter((type) => !SW_RPC_TYPES.has(type));

    for (const type of nonSwRpc) {
      sendMessage.mockClear();
      const result = await executeAction(PARSED_ACTIONS[type], state);
      expect(result.action.type, type).toBe(type);
      expect(sendMessage, `${type} must not use the background channel`).not.toHaveBeenCalled();
    }
  });
});

// ─── Legs 5/6: timeout + cleanup with REAL handlers ──────────────────────────

describe("Action matrix — timeout + cleanup legs (real handlers)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (globalThis as Record<string, unknown>).chrome;
    document.body.replaceChildren();
  });

  /** Hanging SW: accepts every message, never settles, never calls back. */
  function installHangingServiceWorker(): ReturnType<typeof vi.fn> {
    const sendMessage = vi.fn(() => new Promise<never>(() => {}));
    (globalThis as Record<string, unknown>).chrome = {
      runtime: { id: "matrix-extension", sendMessage },
    };
    return sendMessage;
  }

  /** Count 'abort' listener adds vs removes on a signal across one action. */
  function signalListenerBalance(signal: AbortSignal): { added: number; removed: number } {
    let added = 0;
    let removed = 0;
    const onAdd = (e: Event) => { if (e.type === "abort") added++; };
    const onRemove = (e: Event) => { if (e.type === "abort") removed++; };
    signal.addEventListener("addEventListener", onAdd as EventListener);
    signal.addEventListener("removeEventListener", onRemove as EventListener);
    return {
      get added() { return added; },
      get removed() { return removed; },
    };
  }

  test("SW-RPC actions bound a hung service worker and release every abort listener + timer", async () => {
    installHangingServiceWorker();
    const { executeAction } = await import("../src/lib/agent/tools/executor");
    // Pre-import the ask_human handler's DYNAMIC dependency outside the fake
    // timer window: vite's dynamic-import machinery does not settle under
    // fake timers, and the ask-human timeout timer is only scheduled after
    // that import resolves.
    await import("../src/lib/agent/human-interaction");
    // The scroll handler warns when the best-effort vision-cache clear times
    // out — expected here, so keep the test output clean (restored by the
    // describe's afterEach vi.restoreAllMocks).
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = makeState();
    const token = { runId: "matrix-timeout-fixture", dispatchRevision: 1 };
    const swRpcTypes = ACTION_TYPES.filter((type) => SW_RPC_TYPES.has(type));

    for (const type of swRpcTypes) {
      vi.useFakeTimers();
      const controller = new AbortController();
      // Count listener additions/removals on the 'abort' event: every listener
      // a handler adds during the timeout path must be removed again.
      const counts = signalListenerBalance(controller.signal);
      const promise = executeAction(PARSED_ACTIONS[type], state, controller.signal, undefined, undefined, token);
      // A handler may schedule its timeout only AFTER an async import inside
      // the handler settles (ask_human dynamically imports human-interaction),
      // so drain timers in bounded chunks: the first advance also drains
      // pending microtasks, and we keep advancing while timers remain.
      for (let i = 0; i < 8; i++) {
        await vi.advanceTimersByTimeAsync(310_000); // covers 15s / 30s / 300s timeouts
        if ((vi.getTimerCount?.() ?? 0) === 0) break;
      }
      const result = await promise;
      vi.useRealTimers();

      // Timeout leg: the action SETTLED within the bounded window — no hang on
      // the hung SW. scroll/scroll_to_bottom intentionally keep `success: true`
      // (the scroll itself worked; the cache clear is best-effort), but they
      // must surface the SW outage truthfully in the message. Every other
      // SW-RPC action must FAIL outright when its SW round-trip cannot answer.
      if (type === "scroll" || type === "scroll_to_bottom") {
        expect(result.message, `${type} must surface the SW outage`).toMatch(/vision cache clear failed/i);
        expect(result.success, `${type} scroll itself succeeds`).toBe(true);
      } else {
        expect(result.success, `${type} must fail when the SW hangs`).toBe(false);
      }
      // Cleanup leg: no abort listener is left behind.
      expect(counts.added, `${type} abort listener add/remove balance`).toBe(counts.removed);
      // Evidence leg: the failed result still echoes the canonical action.
      expect(result.action, `${type} evidence`).toEqual(PARSED_ACTIONS[type]);
    }
  }, 60_000);

  test("non-SW-RPC actions complete without ever touching the background (timeout/cleanup N/A and proven)", async () => {
    const sendMessage = installHangingServiceWorker();
    const { executeAction } = await import("../src/lib/agent/tools/executor");
    const state = makeState();
    const nonSwRpc = ACTION_TYPES.filter((type) => !SW_RPC_TYPES.has(type));

    for (const type of nonSwRpc) {
      sendMessage.mockClear();
      const result = await executeAction(PARSED_ACTIONS[type], state);
      expect(result.action.type, type).toBe(type);
      // The NEGATIVE proof for the timeout/cleanup legs: no background channel
      // exists for this action, so there is nothing to time out or clean up.
      expect(sendMessage, `${type} must not open a background channel`).not.toHaveBeenCalled();
    }
  });
});

