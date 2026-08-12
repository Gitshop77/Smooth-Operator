/**
 * Action parity contract.
 *
 * `ActionSchema` is the canonical action set.  This suite deliberately keeps
 * one valid fixture for every variant, then uses that same exhaustive set to
 * guard the user-facing description, mode decision, executor switch, and
 * service-worker RPC surfaces.  Additions must update this file consciously:
 * a newly valid action must never silently skip one of those boundaries.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { ActionSchema } from "../src/lib/agent/tools/schema";
import { ACTION_METADATA, actionListForPrompt } from "../src/lib/agent/tools/schema-utils";
import { checkActionAllowed, requiresConfirmation, type AgentMode } from "../src/lib/agent/modes";
import { describeAction } from "../src/lib/agent/tools/describe";
import {
  handleCloseTab,
  handleListTabs,
  handleSwitchTab,
} from "../src/lib/agent/tools/handlers/tab-management";
import { handleGetCookies, handleSetCookie, handleDeleteCookies } from "../src/lib/agent/tools/handlers/cookies";
import { handleGetStorage, handleSetStorage, handleClearStorage } from "../src/lib/agent/tools/handlers/storage";
import { handleNavigate } from "../src/lib/agent/tools/handlers/navigate";
import { handleClick } from "../src/lib/agent/tools/handlers/click";
import { handleInput } from "../src/lib/agent/tools/handlers/input";
import { handleScroll, handleScrollToBottom } from "../src/lib/agent/tools/handlers/scroll";
import { handlePressAndHold } from "../src/lib/agent/tools/handlers/press-and-hold";
import { handleScreenshot } from "../src/lib/agent/tools/handlers/screenshot";
import { handleSaveAsPdf } from "../src/lib/agent/tools/handlers/save-as-pdf";
import { handleDetectVisual } from "../src/lib/agent/tools/handlers/detect-visual";
import {
  handleClearConsoleLog,
  handleDisableConsoleLog,
  handleEnableConsoleLog,
  handleGetConsoleLog,
  handleGetclearConsoleLog,
} from "../src/lib/agent/tools/handlers/console-log";
import {
  handleClearNetworkLog,
  handleDisableNetworkLog,
  handleEnableNetworkLog,
  handleGetNetworkLog,
  handleGetclearNetworkLog,
} from "../src/lib/agent/tools/handlers/network-log";
import type { AgentAction, BrowserState } from "../src/lib/agent/types";
import type { ActionContext } from "../src/lib/agent/tools/handlers/types";

// Keep these as raw inputs, rather than already-parsed Actions: this proves
// every representative is accepted by the canonical schema before it reaches
// any downstream contract.
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
  search: { type: "search", query: "phase three contract", engine: "duckduckgo" },
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
    if (!result.success) throw new Error(`Invalid contract fixture for ${type}: ${result.error.message}`);
    return [type, result.data];
  }),
) as Record<ActionType, AgentAction>;

const MODES: AgentMode[] = ["restricted", "standard", "full_agentic"];
const RESTRICTED_BLOCKED = new Set<ActionType>([
  "navigate", "switch_tab", "close_tab", "search", "evaluate", "run_script",
  "upload_file", "screenshot", "save_as_pdf", "set_cookie", "delete_cookies",
  "set_storage", "clear_storage",
]);
const STANDARD_BLOCKED = new Set<ActionType>([
  "evaluate", "run_script", "upload_file", "screenshot", "save_as_pdf",
]);
const STANDARD_CONFIRMATION = new Set<ActionType>([
  "evaluate", "upload_file", "save_as_pdf", "screenshot", "set_cookie",
  "delete_cookies", "set_storage", "clear_storage",
]);

/**
 * Every action is deliberately classified by its content-script → SW route.
 * `conditional:*` means the handler uses that exact RPC only on its
 * documented path (for example humanized input, a vision click, or a new-tab
 * navigation). Keeping the concrete message type here lets the live-route
 * tests prove this matrix rather than merely restating it.
 */
type BackgroundRoute =
  | "none"
  | "conditional:CDP_CLICK"
  | "conditional:TAB_ACTION"
  | "conditional:CLEAR_VISION_CACHE"
  | "conditional:CDP_PRESS_AND_HOLD"
  | "TAB_ACTION"
  | "NETWORK_LOG"
  | "CONSOLE_LOG"
  | "SCREENSHOT"
  | "SAVE_AS_PDF"
  | "DETECT_VISUAL"
  | "HUMAN_INTERACT_REQUEST";

const BACKGROUND_ROUTE: Record<ActionType, BackgroundRoute> = {
  click: "conditional:CDP_CLICK", input: "conditional:TAB_ACTION", select_dropdown: "none", scroll: "conditional:CLEAR_VISION_CACHE", scroll_to_bottom: "conditional:CLEAR_VISION_CACHE",
  send_keys: "none", navigate: "conditional:TAB_ACTION", switch_tab: "TAB_ACTION", close_tab: "TAB_ACTION", go_back: "none",
  wait: "none", wait_for_element: "none", wait_for_text: "none", wait_for_url: "none", wait_for_network_idle: "none",
  enable_network_log: "NETWORK_LOG", disable_network_log: "NETWORK_LOG", get_network_log: "NETWORK_LOG", clear_network_log: "NETWORK_LOG", getclear_network_log: "NETWORK_LOG",
  enable_console_log: "CONSOLE_LOG", disable_console_log: "CONSOLE_LOG", get_console_log: "CONSOLE_LOG", clear_console_log: "CONSOLE_LOG", getclear_console_log: "CONSOLE_LOG",
  find_text: "none", extract: "none", done: "none", search: "none", upload_file: "none", screenshot: "SCREENSHOT", save_as_pdf: "SAVE_AS_PDF",
  dropdown_options: "none", page_next: "none", list_downloads: "TAB_ACTION", search_page: "none", find_elements: "none", list_interactive: "none",
  get_computed_style: "none", get_page_info: "none", evaluate: "none", run_script: "none", hover: "none", press_and_hold: "conditional:CDP_PRESS_AND_HOLD",
  ask_human: "HUMAN_INTERACT_REQUEST", takeover: "none", verify: "none", load_skill: "none", alert_accept: "none", alert_dismiss: "none", alert_get_text: "none",
  alert_send_keys: "none", detect_visual: "DETECT_VISUAL", detect_challenge: "none", list_tabs: "TAB_ACTION", get_cookies: "TAB_ACTION",
  set_cookie: "TAB_ACTION", delete_cookies: "TAB_ACTION", get_storage: "TAB_ACTION", set_storage: "TAB_ACTION", clear_storage: "TAB_ACTION",
};

describe("AgentAction canonical-set parity", () => {
  test("has one parseable fixture, metadata entry, prompt line, and UI description for every schema member", () => {
    expect(new Set(ACTION_TYPES)).toEqual(new Set(schemaActionTypes()));
    expect(ACTION_TYPES).toHaveLength(schemaActionTypes().length);

    const prompt = actionListForPrompt(50, "adaptive");
    for (const type of ACTION_TYPES) {
      expect(ActionSchema.safeParse(ACTION_FIXTURES[type]).success, type).toBe(true);
      expect(ACTION_METADATA[type], type).toMatchObject({ name: type });
      expect(ACTION_METADATA[type]?.description.trim(), type).not.toBe("");
      expect(prompt, type).toContain(`- ${type}`);
      expect(describeAction(PARSED_ACTIONS[type]), type).not.toMatch(/^unknown action:/);
      expect(describeAction(PARSED_ACTIONS[type]).trim(), type).not.toBe("");
    }
  });

  test("makes an explicit, fail-closed mode and confirmation decision for every schema member", () => {
    for (const type of ACTION_TYPES) {
      for (const mode of MODES) {
        const expectedAllowed = mode === "full_agentic"
          ? true
          : mode === "restricted"
            ? !RESTRICTED_BLOCKED.has(type)
            : !STANDARD_BLOCKED.has(type);
        const decision = checkActionAllowed(type, mode);
        expect(decision.allowed, `${type} in ${mode}`).toBe(expectedAllowed);
        if (!expectedAllowed) expect(decision.reason, `${type} in ${mode}`).toBeTruthy();
        expect(requiresConfirmation(type, mode), `${type} confirmation in ${mode}`).toBe(
          mode === "standard" && STANDARD_CONFIRMATION.has(type),
        );
      }
    }
    expect(checkActionAllowed("not_a_real_action", "full_agentic").allowed).toBe(false);
  });

  test("classifies the background boundary for every schema member", () => {
    expect(new Set(Object.keys(BACKGROUND_ROUTE))).toEqual(new Set(ACTION_TYPES));
    for (const type of ACTION_TYPES) {
      expect(BACKGROUND_ROUTE[type], type).not.toBeUndefined();
    }
  });
});

const HANDLER_BY_ACTION: Partial<Record<ActionType, string>> = {
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
  search_page: "handleSearchPage", find_elements: "handleFindElements", list_interactive: "handleListInteractive",
  get_computed_style: "handleGetComputedStyle", get_page_info: "handleGetPageInfo", evaluate: "handleEvaluate",
  hover: "handleHover", press_and_hold: "handlePressAndHold", ask_human: "handleAskHuman",
  takeover: "handleTakeover", verify: "handleVerify", load_skill: "handleLoadSkill",
  alert_accept: "handleAlertAccept", alert_dismiss: "handleAlertDismiss", alert_get_text: "handleAlertGetText",
  alert_send_keys: "handleAlertSendKeys", detect_visual: "handleDetectVisual", list_tabs: "handleListTabs",
  get_cookies: "handleGetCookies", set_cookie: "handleSetCookie", delete_cookies: "handleDeleteCookies",
  get_storage: "handleGetStorage", set_storage: "handleSetStorage", clear_storage: "handleClearStorage",
};

const HANDLER_NAMES = [...new Set(Object.values(HANDLER_BY_ACTION))] as string[];

describe("AgentAction executor parity", () => {
  afterEach(() => {
    vi.doUnmock("../src/lib/agent/tools/handlers");
    vi.doUnmock("../src/lib/agent/script-runner");
    vi.doUnmock("../src/lib/agent/dom/challenge-snapshot");
    vi.doUnmock("../src/lib/agent/dom/extraction/page-state");
    vi.resetModules();
    delete (globalThis as Record<string, unknown>).chrome;
  });

  test("routes every handler-backed variant through its matching executor branch and handles each direct branch", async () => {
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
      runtime: { id: "contract-extension", sendMessage },
    };

    const { executeAction } = await import("../src/lib/agent/tools/executor");
    const state = { selectorMap: {} } as unknown as BrowserState;
    for (const type of ACTION_TYPES) {
      const result = await executeAction(PARSED_ACTIONS[type], state);
      expect(result.action.type, type).toBe(type);
      const handlerName = HANDLER_BY_ACTION[type];
      if (handlerName) {
        expect(handlers[handlerName] as ReturnType<typeof vi.fn>, type).toHaveBeenCalledOnce();
      } else {
        expect(result.success, `${type} direct executor branch`).toBe(true);
      }
      if (type === "list_downloads") {
        expect(sendMessage)
          .toHaveBeenLastCalledWith(expect.objectContaining({ type: "TAB_ACTION", action: PARSED_ACTIONS.list_downloads }));
      }
    }
  });

  test("threads an exact per-action capability through every executor branch, including conditional effects", async () => {
    const seen: Array<{ type: ActionType; capability: string | undefined }> = [];
    const authorized: AgentAction[] = [];
    const handlers = Object.fromEntries(HANDLER_NAMES.map((name) => [
      name,
      vi.fn(async (ctx: ActionContext, action: AgentAction) => {
        seen.push({ type: action.type as ActionType, capability: ctx.effectCapability });
        return { action, success: true, message: `${name} handled` };
      }),
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
    installRuntime(vi.fn().mockResolvedValue({ ok: true, success: true, message: "downloads" }));

    const { executeAction } = await import("../src/lib/agent/tools/executor");
    const state = { selectorMap: {} } as unknown as BrowserState;
    for (const type of ACTION_TYPES) {
      const capability = `capability-for-${type}`;
      const result = await executeAction(
        PARSED_ACTIONS[type],
        state,
        undefined,
        undefined,
        undefined,
        { runId: "contract-fixture", dispatchRevision: 1 },
        undefined,
        async (candidate) => {
          // The effect boundary must authorize the parsed canonical payload,
          // not a derived action type or a lossy projection of its fields.
          expect(candidate).toEqual(PARSED_ACTIONS[type]);
          authorized.push(candidate);
          return capability;
        },
      );
      expect(result.action).toEqual(PARSED_ACTIONS[type]);
    }

    // This is the executor's universal authorizer, not a handler-local
    // assertion: every parsed schema member must request one authorization,
    // exactly once, before the dispatch switch can reach its branch. Removing
    // or bypassing the boundary for even one action makes this fail.
    expect(authorized).toHaveLength(ACTION_TYPES.length);
    expect(authorized).toEqual(ACTION_TYPES.map((type) => PARSED_ACTIONS[type]));

    for (const type of ["click", "input", "scroll", "scroll_to_bottom", "navigate", "press_and_hold"] as const) {
      expect(seen.find((entry) => entry.type === type), `${type} conditional handler`).toEqual({
        type,
        capability: `capability-for-${type}`,
      });
    }
  });
});

describe("Conditional background routes use live handlers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as Record<string, unknown>).chrome;
    document.body.replaceChildren();
  });

  test("forwards canonical actions, the live dispatch token, and issued capability on every effect-bearing conditional route", async () => {
    // Do not mock the handler registry or any handler module here. These calls
    // execute the real conditional implementations; only DOM/runtime edges are
    // replaced so the test stays deterministic outside a packaged browser.
    const token = { runId: "conditional-routes-fixture", dispatchRevision: 19 };
    const effectCapability = "issued-effect-capability";
    const clickAction = PARSED_ACTIONS.click;
    const humanizedInputAction = ActionSchema.parse({
      ...ACTION_FIXTURES.input,
      humanized: true,
    }) as Extract<AgentAction, { type: "input" }>;
    const humanizedInputDispatch = ActionSchema.parse({
      ...ACTION_FIXTURES.input,
      clear: false,
      humanized: true,
    }) as Extract<AgentAction, { type: "input" }>;
    const scrollAction = PARSED_ACTIONS.scroll;
    const scrollToBottomAction = PARSED_ACTIONS.scroll_to_bottom;
    const navigateAction = PARSED_ACTIONS.navigate;
    const holdAction = PARSED_ACTIONS.press_and_hold as Extract<AgentAction, { type: "press_and_hold" }>;
    const messages: Array<Record<string, unknown>> = [];
    const observedByAction: Partial<Record<ActionType, Array<Record<string, unknown>>>> = {};
    const sendMessage = vi.fn(async (message: Record<string, unknown>) => {
      messages.push(message);
      switch (message.type) {
        case "CDP_CLICK":
        case "CDP_PRESS_AND_HOLD":
        case "CLEAR_VISION_CACHE":
          return { ok: true };
        case "TAB_ACTION":
          return { ok: true, success: true, message: "conditional route accepted", pageChanged: false };
        default:
          return { ok: false, error: `unexpected conditional message ${String(message.type)}` };
      }
    });
    installRuntime(sendMessage);

    const button = document.createElement("button");
    button.textContent = "conditional target";
    const input = document.createElement("input");
    document.body.append(button, input);
    Object.defineProperty(button, "getBoundingClientRect", {
      value: () => ({ x: 10, y: 10, width: 20, height: 20, top: 10, right: 30, bottom: 30, left: 10 }),
    });
    Object.defineProperty(input, "getBoundingClientRect", {
      value: () => ({ x: 10, y: 40, width: 20, height: 20, top: 40, right: 30, bottom: 60, left: 10 }),
    });
    vi.spyOn(window, "scrollBy").mockImplementation(() => undefined);
    vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);

    const context = (selectorMap: Record<number, HTMLElement>): ActionContext => ({
      state: { selectorMap } as unknown as BrowserState,
      beforeUrl: location.href,
      beforeFingerprint: "before-fixture",
      dispatchToken: token,
      effectCapability,
    });

    const observe = async (type: ActionType, call: () => Promise<unknown>): Promise<void> => {
      const before = messages.length;
      await call();
      observedByAction[type] = messages.slice(before);
    };

    // CDP click and press-and-hold are distinct effect-bearing CDP routes.
    await observe("click", async () => {
      await expect(handleClick(context({ 1: button }), clickAction as Extract<AgentAction, { type: "click" }>)).resolves.toMatchObject({ success: true });
    });
    await observe("input", async () => {
      await expect(handleInput(context({ 1: input }), humanizedInputAction)).resolves.toMatchObject({ success: true });
    });

    // The two conditional scroll aliases share the same live cache-clear
    // helper. Dispatch scrollend explicitly so this test is not timer-shaped.
    await observe("scroll", async () => {
      const scroll = handleScroll(context({}), scrollAction as Extract<AgentAction, { type: "scroll" }>);
      window.dispatchEvent(new Event("scrollend"));
      await expect(scroll).resolves.toMatchObject({ success: true });
    });
    await observe("scroll_to_bottom", async () => {
      await expect(handleScrollToBottom(context({}), scrollToBottomAction as Extract<AgentAction, { type: "scroll_to_bottom" }>)).resolves.toMatchObject({ success: true });
    });

    await observe("navigate", async () => {
      await expect(handleNavigate(context({}), navigateAction as Extract<AgentAction, { type: "navigate" }>)).resolves.toMatchObject({ success: true });
    });
    await observe("press_and_hold", async () => {
      await expect(handlePressAndHold(context({ 1: button }), holdAction)).resolves.toMatchObject({ success: true });
    });

    const conditionalTypes = ACTION_TYPES.filter((type) => BACKGROUND_ROUTE[type].startsWith("conditional:"));
    expect(new Set(Object.keys(observedByAction))).toEqual(new Set(conditionalTypes));
    for (const type of conditionalTypes) {
      const expectedMessageType = BACKGROUND_ROUTE[type].slice("conditional:".length);
      expect(observedByAction[type]?.map((message) => message.type), type).toEqual([expectedMessageType]);
    }

    // Effect-bearing conditionals must preserve the background-owned run
    // identity, the complete canonical action, and its one-action proof.
    expect(observedByAction.click).toEqual([{
      type: "CDP_CLICK",
      rect: { x: 10, y: 10, width: 20, height: 20 },
      action: clickAction,
      token,
      effectCapability,
    }]);
    expect(observedByAction.input).toEqual([{
      type: "TAB_ACTION",
      action: humanizedInputDispatch,
      token,
      effectCapability,
    }]);
    expect(observedByAction.navigate).toEqual([{
      type: "TAB_ACTION",
      action: navigateAction,
      token,
      effectCapability,
    }]);
    expect(observedByAction.press_and_hold).toEqual([{
      type: "CDP_PRESS_AND_HOLD",
      x: 20,
      y: 20,
      holdMs: holdAction.hold_ms,
      delayMs: holdAction.delay_ms,
      action: holdAction,
      token,
      effectCapability,
    }]);

    // CLEAR_VISION_CACHE is intentionally a cleanup-only RPC. It proves a
    // live token on both scroll aliases, but deliberately carries neither an
    // action nor an effect capability; this test must not overclaim that it
    // consumes an effect proof.
    expect(observedByAction.scroll).toEqual([{ type: "CLEAR_VISION_CACHE", token }]);
    expect(observedByAction.scroll_to_bottom).toEqual([{ type: "CLEAR_VISION_CACHE", token }]);
  });
});

describe("Content authorization parity", () => {
  afterEach(() => {
    vi.doUnmock("../src/lib/agent/tools/executor");
    vi.resetModules();
    delete (globalThis as Record<string, unknown>).chrome;
  });

  test("sends AUTHORIZE_ACTION_EFFECT with the exact parsed payload for all canonical actions", async () => {
    const observed: AgentAction[] = [];
    vi.doMock("../src/lib/agent/tools/executor", () => ({
      executeAction: async (
        action: AgentAction,
        _state: BrowserState,
        _signal: AbortSignal | undefined,
        _fromLoader: boolean | undefined,
        _mode: AgentMode | undefined,
        _token: { runId: string; dispatchRevision: number } | undefined,
        _capability: string | undefined,
        authorize: ((candidate: AgentAction) => Promise<string>) | undefined,
      ) => {
        const capability = await authorize?.(action);
        observed.push(action);
        return { action, success: capability === `capability-${action.type}`, message: "authorized" };
      },
    }));
    const sendMessage = vi.fn(async (message: { type: string; action?: AgentAction }) => {
      if (message.type === "AUTHORIZE_ACTION_EFFECT") {
        return { ok: true, effectCapability: `capability-${message.action?.type}` };
      }
      return { ok: false, error: `unexpected message ${message.type}` };
    });
    installRuntime(sendMessage);
    const { handleExecuteActions } = await import("../src/extension/content-utils");
    const response = await new Promise<unknown>((resolve) => {
      expect(handleExecuteActions({
        type: "EXECUTE_ACTIONS",
        token: { runId: "authorize-all-fixture", dispatchRevision: 1 },
        secretsResolved: true,
        domainConfig: { allowedDomains: ["example.test"] },
        actions: ACTION_TYPES.map((type) => PARSED_ACTIONS[type]),
      }, resolve)).toBe(true);
    }) as { ok?: boolean; results?: Array<{ success: boolean }>; error?: string };

    expect(response.error).toBeUndefined();
    expect(response.results).toHaveLength(ACTION_TYPES.length);
    expect(response.results?.every((result) => result.success)).toBe(true);
    expect(observed).toEqual(ACTION_TYPES.map((type) => PARSED_ACTIONS[type]));
    const authorizations = sendMessage.mock.calls
      .map(([message]) => message as { type: string; token?: unknown; action?: AgentAction })
      .filter((message) => message.type === "AUTHORIZE_ACTION_EFFECT");
    expect(authorizations).toHaveLength(ACTION_TYPES.length);
    for (const [index, type] of ACTION_TYPES.entries()) {
      expect(authorizations[index]).toEqual({
        type: "AUTHORIZE_ACTION_EFFECT",
        token: { runId: "authorize-all-fixture", dispatchRevision: 1 },
        action: PARSED_ACTIONS[type],
      });
    }
  });
});

function extensionContext(
  dispatchToken?: ActionContext["dispatchToken"],
  effectCapability?: string,
  state: BrowserState = { selectorMap: {} } as unknown as BrowserState,
): ActionContext {
  return {
    state,
    beforeUrl: "https://example.test/",
    beforeFingerprint: "contract",
    dispatchToken,
    effectCapability,
  };
}

function installRuntime(sendMessage: ReturnType<typeof vi.fn>): void {
  (globalThis as Record<string, unknown>).chrome = { runtime: { id: "contract-extension", sendMessage } };
}

describe("AgentAction background-routing parity", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete (globalThis as Record<string, unknown>).chrome;
    document.body.replaceChildren();
  });

  test("sends the exact token, capability, and complete message for every unconditional effect route", async () => {
    const token = { runId: "unconditional-routes-fixture", dispatchRevision: 23 };
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === "SCREENSHOT" || message.type === "SAVE_AS_PDF") {
        return { ok: true, filename: "contract.file" };
      }
      if (message.type === "DETECT_VISUAL") {
        return { ok: true, count: 0, description: "no matches" };
      }
      if (message.type === "NETWORK_LOG" || message.type === "CONSOLE_LOG") {
        return { ok: true, enabled: false, entries: [] };
      }
      return { ok: true, success: true, message: "tab action", downloads: [] };
    });
    installRuntime(sendMessage);
    const handlers: Partial<Record<ActionType, (ctx: ActionContext, action: never) => Promise<unknown>>> = {
      switch_tab: handleSwitchTab as never,
      close_tab: handleCloseTab as never,
      list_tabs: handleListTabs as never,
      get_cookies: handleGetCookies as never,
      set_cookie: handleSetCookie as never,
      delete_cookies: handleDeleteCookies as never,
      get_storage: handleGetStorage as never,
      set_storage: handleSetStorage as never,
      clear_storage: handleClearStorage as never,
      enable_network_log: handleEnableNetworkLog as never,
      disable_network_log: handleDisableNetworkLog as never,
      get_network_log: handleGetNetworkLog as never,
      clear_network_log: handleClearNetworkLog as never,
      getclear_network_log: handleGetclearNetworkLog as never,
      enable_console_log: handleEnableConsoleLog as never,
      disable_console_log: handleDisableConsoleLog as never,
      get_console_log: handleGetConsoleLog as never,
      clear_console_log: handleClearConsoleLog as never,
      getclear_console_log: handleGetclearConsoleLog as never,
      screenshot: handleScreenshot as never,
      save_as_pdf: handleSaveAsPdf as never,
      detect_visual: handleDetectVisual as never,
    };
    const ringVerb: Partial<Record<ActionType, string>> = {
      enable_network_log: "enable", disable_network_log: "disable", get_network_log: "get",
      clear_network_log: "clear", getclear_network_log: "getclear",
      enable_console_log: "enable", disable_console_log: "disable", get_console_log: "get",
      clear_console_log: "clear", getclear_console_log: "getclear",
    };
    const effectRouteTypes = ACTION_TYPES.filter((type) => {
      const route = BACKGROUND_ROUTE[type];
      return route !== "none" && !route.startsWith("conditional:") && route !== "HUMAN_INTERACT_REQUEST";
    });
    expect(new Set([...Object.keys(handlers), "list_downloads"])).toEqual(new Set(effectRouteTypes));

    const { executeAction } = await import("../src/lib/agent/tools/executor");
    for (const type of effectRouteTypes) {
      sendMessage.mockClear();
      const effectCapability = `capability-for-${type}`;
      const ctx = extensionContext(token, effectCapability);
      if (type === "list_downloads") {
        await executeAction(PARSED_ACTIONS[type], ctx.state, undefined, undefined, undefined, token, effectCapability);
      } else {
        await handlers[type]!(ctx, PARSED_ACTIONS[type] as never);
      }

      let expectedMessage: Record<string, unknown>;
      const route = BACKGROUND_ROUTE[type];
      if (route === "TAB_ACTION") {
        expectedMessage = { type: route, action: PARSED_ACTIONS[type], token, effectCapability };
      } else if (route === "NETWORK_LOG" || route === "CONSOLE_LOG") {
        expectedMessage = { type: route, verb: ringVerb[type], token, effectCapability };
      } else if (route === "SCREENSHOT") {
        expectedMessage = { type: route, fileName: "contract.jpg", action: PARSED_ACTIONS[type], token, effectCapability };
      } else if (route === "SAVE_AS_PDF") {
        expectedMessage = { type: route, fileName: "contract.pdf", action: PARSED_ACTIONS[type], token, effectCapability };
      } else if (route === "DETECT_VISUAL") {
        expectedMessage = { type: route, query: "submit button", token, effectCapability };
      } else {
        throw new Error(`Unexpected unconditional effect route for ${type}: ${route}`);
      }
      expect(sendMessage.mock.calls.map(([message]) => message), type).toEqual([expectedMessage]);
      expect((sendMessage.mock.calls[0]?.[0] as { type?: string } | undefined)?.type, type).toBe(route);
    }
  });

  test("routes ask_human through its exact token-only correlated request contract", async () => {
    const token = { runId: "human-route-fixture", dispatchRevision: 29 };
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000029");
    const sendMessage = vi.fn((message: { type: string }, callback?: (response: unknown) => void) => {
      if (message.type === "HUMAN_INTERACT_REQUEST") {
        callback?.({ mode: "input", value: "approved" });
      }
      return Promise.resolve({ ok: true });
    });
    installRuntime(sendMessage);
    const { handleAskHuman } = await import("../src/lib/agent/tools/handlers/ask-human");

    await expect(handleAskHuman(
      extensionContext(token, "unused-effect-capability"),
      PARSED_ACTIONS.ask_human as Extract<AgentAction, { type: "ask_human" }>,
    )).resolves.toMatchObject({ success: true });

    expect(ACTION_TYPES.filter((type) => BACKGROUND_ROUTE[type] === "HUMAN_INTERACT_REQUEST")).toEqual(["ask_human"]);
    expect(sendMessage.mock.calls.map(([message]) => message)).toEqual([{
      type: "HUMAN_INTERACT_REQUEST",
      interactionId: "00000000-0000-4000-8000-000000000029",
      token,
      request: { mode: "input", message: "Continue?" },
      timeoutMs: 300_000,
    }]);
  });

  test("observes no background message for every action classified as none", async () => {
    const token = { runId: "no-background-route-fixture", dispatchRevision: 31 };
    const sendMessage = vi.fn().mockResolvedValue({ ok: false, error: "unexpected background route" });
    installRuntime(sendMessage);
    const { executeAction } = await import("../src/lib/agent/tools/executor");
    const noneTypes = ACTION_TYPES.filter((type) => BACKGROUND_ROUTE[type] === "none");

    for (const type of noneTypes) {
      document.body.replaceChildren();
      let target: HTMLElement;
      if (type === "select_dropdown" || type === "dropdown_options") {
        const select = document.createElement("select");
        select.append(new Option("option", "option"));
        target = select;
      } else if (type === "upload_file") {
        const input = document.createElement("input");
        input.type = "file";
        target = input;
      } else {
        target = document.createElement("button");
      }
      target.classList.add("target");
      target.textContent = "ready needle";
      Object.defineProperty(target, "getBoundingClientRect", {
        value: () => ({ x: 10, y: 10, width: 20, height: 20, top: 10, right: 30, bottom: 30, left: 10 }),
      });
      document.body.append(target);
      const state = { selectorMap: { 1: target } } as unknown as BrowserState;
      sendMessage.mockClear();

      const result = await executeAction(
        PARSED_ACTIONS[type],
        state,
        undefined,
        undefined,
        undefined,
        token,
        `unused-capability-for-${type}`,
      );
      expect(result.action.type, type).toBe(type);
      expect(sendMessage, type).not.toHaveBeenCalled();
    }
  });
});
