/**
 * Executor action tests — verify execution behavior (not just text formatting)
 * for the actions that were previously untested.
 *
 * Covers: takeover, verify, load_skill, done, go_back, wait, screenshot,
 * save_as_pdf, upload_file, dropdown_options, search_page, find_elements.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { executeAction, describeAction } from "../src/lib/agent/tools/executor";
import type { AgentAction } from "../src/lib/agent/types";
import { makeState } from "./helpers";

// ─── describeAction formatting (quick check) ───────────────────────────────

describe("describeAction", () => {
  test("formats all action types without throwing", () => {
    const actions: AgentAction[] = [
      { type: "click", index: 1 } as AgentAction,
      { type: "input", index: 2, text: "hello", clear: true } as AgentAction,
      { type: "select_dropdown", index: 3, text: "Option" } as AgentAction,
      { type: "scroll", down: true, pages: 1 } as AgentAction,
      { type: "send_keys", keys: "Enter" } as AgentAction,
      { type: "navigate", url: "https://x.com", new_tab: false } as AgentAction,
      { type: "switch_tab", tab_id: 1234 } as AgentAction,
      { type: "close_tab", tab_id: 1234 } as AgentAction,
      { type: "go_back" } as AgentAction,
      { type: "wait", seconds: 3 } as AgentAction,
      { type: "find_text", text: "search" } as AgentAction,
      { type: "extract", query: "price" } as AgentAction,
      { type: "done", text: "finished", success: true } as AgentAction,
      { type: "search", query: "test", engine: "duckduckgo" } as AgentAction,
      { type: "upload_file", index: 1, path: "/tmp/file" } as AgentAction,
      { type: "screenshot" } as AgentAction,
      { type: "save_as_pdf" } as AgentAction,
      { type: "dropdown_options", index: 1 } as AgentAction,
      { type: "search_page", pattern: "test", regex: false, case_sensitive: false } as AgentAction,
      { type: "find_elements", selector: ".btn" } as AgentAction,
      { type: "evaluate", code: "return 1;" } as AgentAction,
      { type: "hover", index: 1 } as AgentAction,
      { type: "ask_human", question: "What?" } as AgentAction,
      { type: "takeover", reason: "Login" } as AgentAction,
      { type: "verify", expectation: "success" } as AgentAction,
      { type: "load_skill", name: "github" } as AgentAction,
    ];
    for (const a of actions) {
      const desc = describeAction(a);
      expect(typeof desc).toBe("string");
      expect(desc.length).toBeGreaterThan(0);
    }
  });
});

// ─── Execution behavior tests ───────────────────────────────────────────────

describe("action execution behavior", () => {
  let originalPrompt: typeof window.prompt;
  let originalConfirm: typeof window.confirm;

  beforeEach(() => {
    originalPrompt = window.prompt;
    originalConfirm = window.confirm;
    // F-15: `evaluate` fails closed without an explicit domain allowlist.
    // The jsdom env runs at http://localhost, so allowlist "localhost".
    (globalThis as Record<string, unknown>).__openCoworkDomainConfig = {
      allowedDomains: ["localhost"],
    };
  });
  afterEach(() => {
    window.prompt = originalPrompt;
    window.confirm = originalConfirm;
    delete (globalThis as Record<string, unknown>).__openCoworkDomainConfig;
  });

  test("takeover: returns success with the reason in extractedContent", async () => {
    const action = { type: "takeover", reason: "Login required" } as AgentAction;
    const result = await executeAction(action, makeState());
    expect(result.success).toBe(true);
    expect(result.message).toContain("Login required");
    expect(result.extractedContent).toContain("Login required");
  });

  test("verify: returns success with the expectation in extractedContent", async () => {
    const action = { type: "verify", expectation: "success message visible" } as AgentAction;
    const result = await executeAction(action, makeState());
    expect(result.success).toBe(true);
    expect(result.extractedContent).toContain("success message visible");
  });

  test("done: respects success=true", async () => {
    const action = { type: "done", text: "Task complete", success: true } as AgentAction;
    const result = await executeAction(action, makeState());
    expect(result.success).toBe(true);
    expect(result.isDone).toBe(true);
    expect(result.message).toContain("Task complete");
  });

  test("done: respects success=false", async () => {
    const action = { type: "done", text: "Failed", success: false } as AgentAction;
    const result = await executeAction(action, makeState());
    expect(result.success).toBe(false);
    expect(result.isDone).toBe(true);
    expect(result.message).toContain("Failed");
  });

  test("wait: waits the specified seconds", async () => {
    const action = { type: "wait", seconds: 1 } as AgentAction;
    const start = Date.now();
    const result = await executeAction(action, makeState());
    const elapsed = Date.now() - start;
    expect(result.success).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(900); // ~1s
  });

  test("go_back: returns success", async () => {
    const action = { type: "go_back" } as AgentAction;
    const result = await executeAction(action, makeState());
    expect(result.success).toBe(true);
  });

  test("screenshot: returns an honest failure when not in extension context", async () => {
    // The screenshot action routes through chrome.runtime.sendMessage to the
    // background SW (which has chrome.tabs.captureVisibleTab + chrome.downloads).
    // In the jsdom test environment there's no chrome.runtime.id, so the
    // action must return an honest failure rather than falsely claiming the
    // extension will handle the capture.
    const action = { type: "screenshot" } as AgentAction;
    const result = await executeAction(action, makeState());
    expect(result.success).toBe(false);
    expect(result.message).toContain("not supported");
  });

  test("save_as_pdf: returns an honest failure when not in extension context", async () => {
    // save_as_pdf routes through chrome.runtime.sendMessage to the background
    // SW (which uses CDP Page.printToPDF + chrome.downloads). In the jsdom
    // test environment there's no chrome.runtime.id, so the action must
    // return an honest failure rather than falsely claiming success.
    const action = { type: "save_as_pdf" } as AgentAction;
    const result = await executeAction(action, makeState());
    expect(result.success).toBe(false);
    expect(result.message).toContain("not supported");
  });

  test("dropdown_options: throws for non-select element", async () => {
    // Create a mock state with a non-select element at index 1.
    const mockEl = document.createElement("div");
    const state = makeState({ selectorMap: { 1: mockEl } });
    const action = { type: "dropdown_options", index: 1 } as AgentAction;
    const result = await executeAction(action, state);
    expect(result.success).toBe(false);
    expect(result.message).toContain("not a <select>");
  });

  test("dropdown_options: lists options for a <select>", async () => {
    const select = document.createElement("select");
    const opt1 = document.createElement("option");
    opt1.textContent = "Option A";
    opt1.value = "a";
    const opt2 = document.createElement("option");
    opt2.textContent = "Option B";
    opt2.value = "b";
    select.appendChild(opt1);
    select.appendChild(opt2);
    const state = makeState({ selectorMap: { 1: select } });
    const action = { type: "dropdown_options", index: 1 } as AgentAction;
    const result = await executeAction(action, state);
    expect(result.success).toBe(true);
    expect(result.extractedContent).toContain("Option A");
    expect(result.extractedContent).toContain("Option B");
  });

  test("search_page: finds text matches", async () => {
    // Set up a page with some text.
    document.body.innerHTML = "<div>Hello world. Hello again.</div>";
    const action = { type: "search_page", pattern: "Hello", regex: false, case_sensitive: false } as AgentAction;
    const result = await executeAction(action, makeState());
    expect(result.success).toBe(true);
    // search_page counts text NODES containing the pattern, not occurrences.
    // "Hello world. Hello again." is one text node → 1 match.
    expect(result.message).toContain("1 match");
    document.body.innerHTML = "";
  });

  test("search_page: returns no matches for absent text", async () => {
    document.body.innerHTML = "<div>No matching text here.</div>";
    const action = { type: "search_page", pattern: "xyzzy", regex: false, case_sensitive: false } as AgentAction;
    const result = await executeAction(action, makeState());
    // search_page is read-only; success=true even on 0 matches
    // (the search succeeded, it just found nothing — same as find_elements).
    expect(result.success).toBe(true);
    expect(result.message).toContain("No matches");
    document.body.innerHTML = "";
  });

  test("search_page rejects overly long regex patterns", async () => {
    const longPattern = "a".repeat(600);
    const action = { type: "search_page", pattern: longPattern, regex: true, case_sensitive: false } as AgentAction;
    const result = await executeAction(action, makeState());
    expect(result.success).toBe(false);
    expect(result.message).toContain("too long");
  });

  test("search_page catches invalid regex", async () => {
    const action = { type: "search_page", pattern: "[invalid", regex: true, case_sensitive: false } as AgentAction;
    const result = await executeAction(action, makeState());
    expect(result.success).toBe(false);
    expect(result.message).toContain("Invalid regex");
  });

  test("find_elements: finds elements by CSS selector", async () => {
    document.body.innerHTML = '<div><button class="btn">A</button><button class="btn">B</button></div>';
    const action = { type: "find_elements", selector: ".btn", max_results: 50 } as AgentAction;
    const result = await executeAction(action, makeState());
    expect(result.success).toBe(true);
    expect(result.message).toContain("2 elements");
    document.body.innerHTML = "";
  });

  test("evaluate: executes JS and returns the result", async () => {
    const action = { type: "evaluate", code: "return 2 + 2;" } as AgentAction;
    const result = await executeAction(action, makeState());
    expect(result.success).toBe(true);
    expect(result.extractedContent).toContain("4");
  });

  test("evaluate: read-only script reports pageChanged: false (F-19)", async () => {
    // A pure computation mutates neither the URL nor the DOM fingerprint,
    // so it must NOT be reported as a page change. The old code reported
    // `pageChanged: true` unconditionally — that reset the loop detector's
    // repetition window on every read-only evaluate and forced a full DOM
    // re-extract each step.
    const action = { type: "evaluate", code: "return 2 + 2;" } as AgentAction;
    const result = await executeAction(action, makeState());
    expect(result.success).toBe(true);
    expect(result.pageChanged).toBe(false);
  });

  test("evaluate: a script that changes the URL reports pageChanged: true (F-19)", async () => {
    const action = { type: "evaluate", code: "window.history.pushState({}, '', '/changed'); return 1;" } as AgentAction;
    const result = await executeAction(action, makeState());
    expect(result.success).toBe(true);
    expect(result.pageChanged).toBe(true);
  });

  test("load_skill: returns failure for unknown skill", async () => {
    const action = { type: "load_skill", name: "nonexistent_skill_xyz" } as AgentAction;
    const result = await executeAction(action, makeState());
    expect(result.success).toBe(false);
    expect(result.message).toContain("not found");
  });

  test("load_skill: returns the skill body for a known skill", async () => {
    const action = { type: "load_skill", name: "GitHub" } as AgentAction;
    const result = await executeAction(action, makeState());
    expect(result.success).toBe(true);
    expect(result.extractedContent).toContain("GitHub tips");
  });

  test("ask_human: calls window.prompt and surfaces the answer", async () => {
    window.prompt = vi.fn(() => "my answer") as typeof window.prompt;
    const action = { type: "ask_human", question: "What is your name?" } as AgentAction;
    const result = await executeAction(action, makeState());
    expect(result.success).toBe(true);
    expect(result.message).toContain("my answer");
    expect(window.prompt).toHaveBeenCalled();
  });
});
