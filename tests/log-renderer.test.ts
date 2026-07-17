/**
 * Trust-boundary validators in `sidepanel/log-renderer.ts`.
 *
 * `log-renderer.ts` imports the side-panel element refs (`elements.ts`, which
 * use `$()` for REQUIRED ids) and registers a `chrome.runtime.onMessage`
 * listener at import time, so we stub `chrome` and create the required ids
 * before the dynamic import.
 */

import { describe, test, expect, beforeAll } from "vitest";

let store: Record<string, unknown> = {};

function setupGlobals(): void {
  store = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      lastError: undefined,
      id: "test",
      onMessage: { addListener: () => {} },
      sendMessage: (_msg: unknown, _cb?: (res: unknown) => void) => {},
    },
    storage: {
      local: {
        get: (_k: unknown, cb: (res: unknown) => void) => cb(store),
        set: (v: Record<string, unknown>) => { Object.assign(store, v); return Promise.resolve(); },
        remove: () => Promise.resolve(),
      },
      session: { get: () => {}, set: () => {}, remove: () => {} },
    },
  };

  document.body.innerHTML = `
    <textarea id="task"></textarea>
    <button id="runBtn"></button>
    <button id="stopBtn"></button>
    <div id="log"></div>
    <span id="stepLabel"></span>
    <span id="countLabel"></span>
    <span id="barFill"></span>
    <span id="liveDot"></span>
    <span id="costLabel"></span>
    <span id="tokenLabel"></span>
  `;
}

describe("log-renderer trust-boundary validators", () => {
  let isValidAgentEvent: (ev: unknown) => boolean;
  let isFiniteCostEvent: (e: unknown) => boolean;
  let addLogRow: (event: unknown, time: string) => void;
  let restoreTotalsFromStorage: () => void;
  let clearRunTotals: () => void;
  let costLabel: HTMLElement;
  let logEl: HTMLElement;

  beforeAll(async () => {
    setupGlobals();
    const mod = await import("../src/extension/sidepanel/log-renderer");
    isValidAgentEvent = mod.isValidAgentEvent;
    isFiniteCostEvent = mod.isFiniteCostEvent;
    addLogRow = mod.addLogRow as unknown as (event: unknown, time: string) => void;
    restoreTotalsFromStorage = mod.restoreTotalsFromStorage;
    clearRunTotals = mod.clearRunTotals;
    costLabel = document.getElementById("costLabel") as HTMLElement;
    logEl = document.getElementById("log") as HTMLElement;
  });

  test("isValidAgentEvent gates cost vs state events", () => {
    // Well-formed events are accepted.
    expect(isValidAgentEvent({ type: "cost", costUsd: 1, tokensIn: 1, tokensOut: 1 })).toBe(true);
    expect(isValidAgentEvent({ type: "state" })).toBe(true);
    expect(isValidAgentEvent({ type: "action", index: 1, total: 2, description: "x" })).toBe(true);
    // Non-object / null / undefined envelopes are rejected.
    expect(isValidAgentEvent(null)).toBe(false);
    expect(isValidAgentEvent(undefined)).toBe(false);
    expect(isValidAgentEvent("cost")).toBe(false);
    expect(isValidAgentEvent(42)).toBe(false);
    // Missing / non-string `type` is rejected.
    expect(isValidAgentEvent({})).toBe(false);
    expect(isValidAgentEvent({ type: 123 })).toBe(false);
  });

  test("isValidAgentEvent rejects malformed cost numeric fields", () => {
    // Any non-finite field (or a missing field) makes the cost envelope invalid.
    expect(isValidAgentEvent({ type: "cost", costUsd: "x" })).toBe(false);
    expect(isValidAgentEvent({ type: "cost", costUsd: 1, tokensIn: "x", tokensOut: 1 })).toBe(false);
    expect(isValidAgentEvent({ type: "cost", costUsd: 1, tokensIn: 1 })).toBe(false);
    expect(isValidAgentEvent({ type: "cost", costUsd: NaN })).toBe(false);
    expect(isValidAgentEvent({ type: "cost" })).toBe(false);
  });

  test("isFiniteCostEvent requires finite numeric fields", () => {
    expect(isFiniteCostEvent({ costUsd: 1, tokensIn: 2, tokensOut: 3 })).toBe(true);
    // Rejects string-non-number, the numeric NaN sentinel, and missing fields.
    expect(isFiniteCostEvent({ costUsd: "NaN" })).toBe(false);
    expect(isFiniteCostEvent({ costUsd: 1, tokensIn: "x", tokensOut: 3 })).toBe(false);
    expect(isFiniteCostEvent({ costUsd: NaN })).toBe(false);
    expect(isFiniteCostEvent({ costUsd: undefined })).toBe(false);
    expect(isFiniteCostEvent({})).toBe(false);
  });

  test("addLogRow drops a malformed cost event without changing totals", () => {
    expect(costLabel.textContent).toBe("");
    expect(() =>
      addLogRow({ type: "cost", costUsd: "x", tokensIn: 2, tokensOut: 3 }, ""),
    ).not.toThrow();
    // Totals must remain untouched (no NaN poison).
    expect(costLabel.textContent).toBe("");
  });

  test("addLogRow escapes an HTML-injection payload in an info body (no live element)", () => {
    logEl.innerHTML = "";
    addLogRow({ type: "info", message: '<img src=x onerror=alert(1)>' }, "t0");
    const row = logEl.lastElementChild as HTMLElement;
    expect(row).not.toBeNull();
    const bd = row.querySelector(".bd") as HTMLElement;
    // The raw tag is escaped — no <img> element was actually created.
    expect(bd.querySelector("img")).toBeNull();
    expect(bd.innerHTML).toContain("&lt;img");
    expect(bd.innerHTML).not.toContain("<img");
  });

  test("addLogRow escapes script payloads in an action body", () => {
    logEl.innerHTML = "";
    addLogRow(
      { type: "action", step: 1, index: 1, total: 1, name: "click", description: "<script>alert('xss')</script>" },
      "t1",
    );
    const row = logEl.lastElementChild as HTMLElement;
    const bd = row.querySelector(".bd") as HTMLElement;
    expect(bd.querySelector("script")).toBeNull();
    expect(bd.innerHTML).toContain("&lt;script&gt;");
  });

  test("addLogRow escapes a markup payload in an error body (recoverable path)", () => {
    logEl.innerHTML = "";
    addLogRow({ type: "error", step: 1, recoverable: true, message: "<b>oops</b>" }, "t2");
    const row = logEl.lastElementChild as HTMLElement;
    const bd = row.querySelector(".bd") as HTMLElement;
    expect(bd.querySelector("b")).toBeNull();
    expect(bd.innerHTML).toContain("&lt;b&gt;oops&lt;/b&gt;");
  });

  test("restoreTotalsFromStorage replays step + count progress indicators", () => {
    // Reset any in-memory leftovers from earlier tests so the restore path
    // replays from the persisted snapshot (the `logHistory.length === 0`
    // guard only fires the replay on a clean panel open).
    clearRunTotals();
    // Persist a mid-run snapshot: reached step 5 with 42 elements visible.
    store["__oc_costUsd"] = 1.5;
    store["__oc_tokens"] = 100;
    store["__oc_log"] = [
      { event: { type: "navigator-step-start", step: 5 }, time: "t1" },
      { event: { type: "state", elementCount: 42, newElementCount: 1, pageInfo: "x" }, time: "t2" },
    ];

    const stepLabel = document.getElementById("stepLabel") as HTMLElement;
    const countLabel = document.getElementById("countLabel") as HTMLElement;
    const barFill = document.getElementById("barFill") as HTMLElement;

    restoreTotalsFromStorage();

    // Cost/tokens restored.
    expect(costLabel.textContent).toBe("$1.5000");
    // Step label, progress bar width, and element-count label restored from
    // the replayed navigator-step-start / state events (not reset to 0).
    expect(stepLabel.textContent).toContain("5");
    expect(barFill.style.width).toBe("5%");
    expect(countLabel.textContent).toBe("42 el");
  });
});
