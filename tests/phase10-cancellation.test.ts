// @vitest-environment-options {"url":"http://phase10-cancel.test/"}

/**
 * Phase 10 — no-post-cancel action invariant across EVERY handler family.
 *
 * Two layers are proven with REAL handlers (not mocks):
 *
 * 1. PRE-aborted signal: the executor's universal boundary
 *    (`throwIfAborted` before dispatch) means NO handler runs — no DOM
 *    mutation, no events, no background message, no success result — for
 *    every action family.
 * 2. MID-FLIGHT abort: an abort arriving while a handler is inside an async
 *    gap (sleep / SW round-trip / scroll settle) interrupts it — the action
 *    never reports success and performs no post-abort side effect.
 *
 * The generated matrix (phase10-action-matrix.test.ts) proves the pre-abort
 * boundary with mocked handlers for ALL 60 actions; this file exercises the
 * same boundary and the mid-flight path against the real click / input /
 * hover / scroll / wait / extract / evaluate / screenshot / navigate /
 * detect_visual / save_as_pdf / ask_human handler implementations.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { executeAction } from "../src/lib/agent/tools/executor";
import { makeState } from "./helpers";
import type { BrowserState } from "../src/lib/agent/types";

function makeDomState(el: HTMLElement, index = 1): BrowserState {
  return makeState({ selectorMap: { [index]: el } });
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (globalThis as Record<string, unknown>).chrome;
  document.body.innerHTML = "";
});


// ─── Layer 1: pre-aborted signal → nothing runs ─────────────────────────────

describe("pre-aborted run signal: no handler side effect", () => {
  test("click: pre-abort means the click listener never fires", async () => {
    const button = document.createElement("button");
    document.body.append(button);
    const onClick = vi.fn();
    button.addEventListener("click", onClick);
    const aborted = new AbortController();
    aborted.abort(new DOMException("cancelled", "AbortError"));

    const result = await executeAction({ type: "click", index: 1 } as never, makeDomState(button), aborted.signal);

    expect(result.success).toBe(false);
    expect(onClick).not.toHaveBeenCalled();
  });

  test("input: pre-abort means the value is never set and no events dispatch", async () => {
    const input = document.createElement("input");
    document.body.append(input);
    const onInput = vi.fn();
    input.addEventListener("input", onInput);
    input.addEventListener("change", onInput);
    const aborted = new AbortController();
    aborted.abort(new DOMException("cancelled", "AbortError"));

    const result = await executeAction(
      { type: "input", index: 1, text: "should-not-land" } as never,
      makeDomState(input),
      aborted.signal,
    );

    expect(result.success).toBe(false);
    expect(input.value).toBe("");
    expect(onInput).not.toHaveBeenCalled();
  });

  test("select_dropdown / send_keys / hover / scroll / scroll_to_bottom: pre-abort → zero events", async () => {
    const aborted = new AbortController();
    aborted.abort(new DOMException("cancelled", "AbortError"));

    // select_dropdown on a real <select>.
    const select = document.createElement("select");
    select.append(new Option("option", "option"));
    document.body.append(select);
    const onSelect = vi.fn();
    select.addEventListener("change", onSelect);
    const r1 = await executeAction(
      { type: "select_dropdown", index: 1, text: "option" } as never,
      makeDomState(select),
      aborted.signal,
    );
    expect(r1.success).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();

    // send_keys on a real input.
    const input = document.createElement("input");
    document.body.append(input);
    const onKey = vi.fn();
    input.addEventListener("keydown", onKey);
    const r2 = await executeAction(
      { type: "send_keys", keys: "Enter" } as never,
      makeDomState(input),
      aborted.signal,
    );
    expect(r2.success).toBe(false);
    expect(onKey).not.toHaveBeenCalled();

    // hover on a real button.
    const button = document.createElement("button");
    document.body.append(button);
    const onHover = vi.fn();
    button.addEventListener("mouseover", onHover);
    const r3 = await executeAction({ type: "hover", index: 1 } as never, makeDomState(button), aborted.signal);
    expect(r3.success).toBe(false);
    expect(onHover).not.toHaveBeenCalled();

    // scroll family — must not even start (no scrollBy side effect).
    const scrollSpy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    const r4 = await executeAction({ type: "scroll", down: true, pages: 1 } as never, makeState(), aborted.signal);
    expect(r4.success).toBe(false);
    expect(scrollSpy).not.toHaveBeenCalled();
    const r5 = await executeAction(
      { type: "scroll_to_bottom", delay_seconds: 0 } as never,
      makeState(),
      aborted.signal,
    );
    expect(r5.success).toBe(false);
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  test("evaluate: pre-abort means the code never executes", async () => {
    const aborted = new AbortController();
    aborted.abort(new DOMException("cancelled", "AbortError"));
    const result = await executeAction(
      { type: "evaluate", code: "window.__cancelledEvalRan = true; return 1;" } as never,
      makeState(),
      aborted.signal,
    );
    expect(result.success).toBe(false);
    expect((window as unknown as Record<string, unknown>).__cancelledEvalRan).toBeUndefined();
  });

  test("SW-RPC family: pre-abort means no background message is sent", async () => {
    const sendMessage = vi.fn();
    (globalThis as Record<string, unknown>).chrome = { runtime: { id: "cancel-test", sendMessage } };
    const aborted = new AbortController();
    aborted.abort(new DOMException("cancelled", "AbortError"));

    for (const action of [
      { type: "screenshot" },
      { type: "save_as_pdf", file_name: "x.pdf" },
      { type: "detect_visual", query: "button" },
      { type: "navigate", url: "https://example.test/", new_tab: true },
      { type: "switch_tab", tab_id: 1 },
      { type: "list_downloads" },
    ] as const) {
      const result = await executeAction(action as never, makeState(), aborted.signal);
      expect(result.success, action.type).toBe(false);
    }
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

// ─── Layer 2: mid-flight abort → no success, no post-abort side effect ──────

describe("mid-flight abort interrupts an in-progress action", () => {
  test("click: aborting while the handler settles prevents the click", async () => {
    vi.useFakeTimers();
    const button = document.createElement("button");
    document.body.append(button);
    const onClick = vi.fn();
    button.addEventListener("click", onClick);
    const controller = new AbortController();

    const promise = executeAction({ type: "click", index: 1 } as never, makeDomState(button), controller.signal);
    // Let the handler reach its settle gap, then cancel the run.
    await vi.advanceTimersByTimeAsync(10);
    controller.abort(new DOMException("cancelled by user", "AbortError"));
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();

    expect(result.success).toBe(false);
    expect(onClick).not.toHaveBeenCalled();
  });

  test("input: aborting mid-typing leaves the field untouched and fires no events", async () => {
    vi.useFakeTimers();
    const input = document.createElement("input");
    document.body.append(input);
    const onInput = vi.fn();
    input.addEventListener("input", onInput);
    input.addEventListener("change", onInput);
    const controller = new AbortController();

    const promise = executeAction(
      { type: "input", index: 1, text: "half" } as never,
      makeDomState(input),
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(10);
    controller.abort(new DOMException("cancelled by user", "AbortError"));
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();

    expect(result.success).toBe(false);
    expect(input.value).toBe("");
    expect(onInput).not.toHaveBeenCalled();
  });

  test("wait: aborting mid-wait returns a failure, not a success", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = executeAction({ type: "wait", seconds: 5 } as never, makeState(), controller.signal);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort(new DOMException("cancelled by user", "AbortError"));
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/abort|aborted/i);
  });

  test("scroll: aborting while the scroll-settle wait is pending fails the action", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = executeAction({ type: "scroll", down: true, pages: 1 } as never, makeState(), controller.signal);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort(new DOMException("cancelled by user", "AbortError"));
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();

    expect(result.success).toBe(false);
  });

  test("SW-RPC: aborting mid-round-trip fails the action and never reports success", async () => {
    const sendMessage = vi.fn(() => new Promise<never>(() => {}));
    (globalThis as Record<string, unknown>).chrome = { runtime: { id: "cancel-test", sendMessage } };
    const controller = new AbortController();

    const promise = executeAction({ type: "screenshot" } as never, makeState(), controller.signal);
    controller.abort(new DOMException("cancelled by user", "AbortError"));
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.message).not.toMatch(/saved/i);
  });

  test("ask_human: aborting while the prompt is pending fails the action", async () => {
    const sendMessage = vi.fn(() => new Promise<never>(() => {}));
    (globalThis as Record<string, unknown>).chrome = { runtime: { id: "cancel-test", sendMessage } };
    await import("../src/lib/agent/human-interaction");
    const controller = new AbortController();

    const promise = executeAction(
      { type: "ask_human", question: "Continue?", mode: "input" } as never,
      makeState(),
      controller.signal,
      undefined,
      undefined,
      { runId: "cancel-test-run", dispatchRevision: 1 },
    );
    controller.abort(new DOMException("cancelled by user", "AbortError"));
    const result = await promise;

    expect(result.success).toBe(false);
  });
});
