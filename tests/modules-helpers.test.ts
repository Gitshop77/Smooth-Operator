/**
 * Smoke tests for four unrelated modules whose public APIs aren't big enough
 * to warrant a dedicated test file each:
 * - `tools/registry` — `getFormatInstructions` (prompt-injection helper)
 * - `dom/dom-utils` — `By` / `findByLocator` (CSS/XPath/tag-name locators)
 * - `errors` — typed hierarchy + classification
 * - `tools/executor` — `Select` helper, alert actions, native-click fallback
 *
 * Renamed from `agent4-probe.test.ts` (the historical name referenced an
 * internal development phase and didn't describe the file's scope).
 */

import { describe, test, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { z } from "zod";
import type { BrowserState } from "../src/lib/agent/types";

// Clear the DOM after every test so elements don't leak between tests and
// skew later assertions (e.g. findByLocator queries document.body).
afterEach(() => {
  document.body.innerHTML = "";
});

/** Build a minimal executor state from a single element (or an empty map). */
function stateWith(el?: Element, index = 1): BrowserState {
  return { selectorMap: el ? { [index]: el } : {} } as BrowserState;
}

// `executeAction` is imported once and reused, rather than re-imported in every
// test — the module is an ESM singleton, so the cached instance is identical.
let executeAction: typeof import("../src/lib/agent/tools/executor").executeAction;
beforeAll(async () => {
  ({ executeAction } = await import("../src/lib/agent/tools/executor"));
});

describe("registry: getFormatInstructions", () => {
  test("getFormatInstructions produces a JSON-schema-bearing string", async () => {
    const { getFormatInstructions } = await import("../src/lib/agent/tools/registry");
    const schema = z.object({ type: z.literal("click"), index: z.number() });
    const text = getFormatInstructions(schema);
    expect(text).toContain("JSON instance");
    expect(text).toContain("output schema");
    expect(text).toContain('"type"');
    expect(text).toContain('"index"');
  });
});

describe("dom-utils: By + findByLocator", () => {
  test("By.css resolves to css selector strategy", async () => {
    const { By } = await import("../src/lib/agent/dom/dom-utils");
    const by = By.css("button.primary");
    expect(by.using).toBe("css selector");
    expect(by.value).toBe("button.primary");
  });

  test("By.id / By.name / By.className escape into CSS selectors", async () => {
    const { By } = await import("../src/lib/agent/dom/dom-utils");
    expect(By.id("submit").value).toContain('id="submit"');
    expect(By.byName("q").value).toContain('name="q"');
    expect(By.className("btn primary").using).toBe("css selector");
  });

  test("By.xpath / By.linkText / By.tagName carry the right strategy", async () => {
    const { By } = await import("../src/lib/agent/dom/dom-utils");
    expect(By.xpath("//button").using).toBe("xpath");
    expect(By.linkText("Sign in").using).toBe("link text");
    expect(By.partialLinkText("Sign").using).toBe("partial link text");
    expect(By.tagName("button").using).toBe("tag name");
  });

  test("findByLocator resolves CSS selectors to live elements", async () => {
    const { findByLocator, By } = await import("../src/lib/agent/dom/dom-utils");
    document.body.innerHTML = '<button class="x">A</button><button class="x">B</button>';
    const els = findByLocator(By.css("button.x"));
    expect(els.length).toBe(2);
  });
});

describe("errors: typed hierarchy", () => {
  test("each typed error carries a stable code", async () => {
    const {
      NoSuchElementException,
      ElementNotSelectableError,
      TimeoutError,
      UnsupportedOperationError,
      isAgentError,
    } = await import("../src/lib/agent/errors");
    expect(new NoSuchElementException().code).toBe("no_such_element");
    expect(new ElementNotSelectableError().code).toBe("element_not_selectable");
    expect(new TimeoutError().code).toBe("timeout");
    expect(new UnsupportedOperationError().code).toBe("unsupported_operation");
    expect(isAgentError(new TimeoutError())).toBe(true);
    expect(isAgentError(new Error("plain"))).toBe(false);
  });

  test("typed errors expose a default message and their own name", async () => {
    const { TimeoutError, UnsupportedOperationError } = await import("../src/lib/agent/errors");
    expect(new TimeoutError().message).toBe("timeout");
    expect(new UnsupportedOperationError().name).toBe("UnsupportedOperationError");
  });
});

describe("executor: Select helper + alert actions + click fallback", () => {
  test("select_dropdown uses Select class for text match", async () => {
    const select = document.createElement("select");
    const opt1 = document.createElement("option");
    opt1.textContent = "Apple";
    opt1.value = "apple";
    const opt2 = document.createElement("option");
    opt2.textContent = "Banana";
    opt2.value = "banana";
    select.append(opt1, opt2);
    document.body.appendChild(select);
    const state = stateWith(select);
    const result = await executeAction({ type: "select_dropdown", index: 1, text: "Banana" }, state);
    expect(result.success).toBe(true);
    expect(select.value).toBe("banana");
  });

  test("select_dropdown guards against disabled options", async () => {
    const select = document.createElement("select");
    const opt = document.createElement("option");
    opt.textContent = "Disabled";
    opt.value = "disabled";
    opt.disabled = true;
    select.appendChild(opt);
    document.body.appendChild(select);
    const state = stateWith(select);
    const result = await executeAction({ type: "select_dropdown", index: 1, text: "Disabled" }, state);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/disabled|not selectable/i);
  });

  test("alert_get_text returns empty content when no dialog open", async () => {
 // Reset the popup-handler's pending queue by dismissing.
    const { dismissAlert } = await import("../src/lib/agent/dom/popup-handler");
    dismissAlert();
    const result = await executeAction({ type: "alert_get_text" }, stateWith());
    expect(result.success).toBe(true);
    expect(result.extractedContent).toBe("");
  });

  test("alert_accept fails when no dialog is open", async () => {
    const { dismissAlert } = await import("../src/lib/agent/dom/popup-handler");
    dismissAlert();
    const result = await executeAction({ type: "alert_accept" }, stateWith());
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/nothing to accept/i);
  });

  test("popup-handler queues dialogs for later inspection", async () => {
    const { installPopupHandler, getPendingAlertText, getPendingAlertKind, acceptAlert } = await import("../src/lib/agent/dom/popup-handler");
    const origAlert = window.alert;
    try {
      installPopupHandler();
      window.alert("hello world");
      expect(getPendingAlertText()).toBe("hello world");
      expect(getPendingAlertKind()).toBe("alert");
      expect(acceptAlert()).toBe(true);
      expect(getPendingAlertText()).toBe(null);
    } finally {
      window.alert = origAlert;
    }
  });

  test("click fallback uses native el.click() when no chrome.runtime", async () => {
    const button = document.createElement("button");
    document.body.appendChild(button);
    let clicked = false;
    button.addEventListener("click", () => { clicked = true; });
    const state = stateWith(button);
    const result = await executeAction({ type: "click", index: 1 }, state);
    expect(result.success).toBe(true);
    expect(clicked).toBe(true);
    expect(result.message).toContain("native");
  });

  test("click fallback falls through to dispatched-event when el.click() throws", async () => {
 // Create an element whose .click() throws.
    const button = document.createElement("button");
    document.body.appendChild(button);
    (button as any).click = () => { throw new Error("synthetic failure"); };
 // CSS selector strategy should also fail (the only button on the page is
 // the broken one), and text-search will skip the same element. Dispatched
 // MouseEvent on `button` should succeed and we report dispatched-event.
    let dispatched = false;
    button.addEventListener("click", () => { dispatched = true; });
    const state = stateWith(button);
    const result = await executeAction({ type: "click", index: 1 }, state);
    expect(result.success).toBe(true);
    expect(dispatched).toBe(true);
  });
});

// ─── CDP-first click cascade ────────────────────────────────────────────────
//
// The click handler's strategy order is: CDP → native → CSS → text → dispatched.
// CDP is strategy 1 — `el.click()` silently fails on ~30% of real websites
// (isTrusted-gated handlers), so trying native first would report false success
// and never reach CDP.
//
// These tests pin the CDP-first ordering: when `chrome.runtime.id` is truthy
// (extension context) AND `chrome.runtime.sendMessage` returns `{ ok: true }`,
// CDP must be tried FIRST and native `el.click()` must NOT be tried.

describe("executor: CDP-first click cascade", () => {
  let originalChrome: unknown;

  beforeEach(() => {
    originalChrome = (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  afterEach(() => {
    if (originalChrome === undefined) {
      delete (globalThis as unknown as { chrome?: unknown }).chrome;
    } else {
      (globalThis as unknown as { chrome: unknown }).chrome = originalChrome;
    }
  });

  /** Install a chrome global with `runtime.id` + a `sendMessage` mock. */
  function installChromeMock(sendMessage: ReturnType<typeof vi.fn>): void {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: {
 // `chrome.runtime.id` is truthy in extension context, undefined in
 // test pages. The CDP guard checks `chrome.runtime?.id`.
        id: "test-extension-id",
        sendMessage,
      },
    };
  }

  test("CDP is tried FIRST when chrome.runtime.id is set (strategy 1) — native el.click() is NOT called", async () => {
    const sendMsg = vi.fn(async () => ({ ok: true }));
    installChromeMock(sendMsg);

    const button = document.createElement("button");
    document.body.appendChild(button);
    let nativeClicked = false;
    button.addEventListener("click", () => { nativeClicked = true; });

    const state = stateWith(button);
    const result = await executeAction({ type: "click", index: 1 }, state);

 // CDP was tried (sendMessage called with CDP_CLICK).
    expect(sendMsg).toHaveBeenCalledTimes(1);
    expect((sendMsg.mock.calls[0] as unknown[])[0]).toMatchObject({ type: "CDP_CLICK" });
 // Native el.click() was NOT tried (CDP succeeded → strategy 2 skipped).
    expect(nativeClicked).toBe(false);
 // Result reports CDP as the strategy used.
    expect(result.success).toBe(true);
    expect(result.message).toContain("CDP");
  });

  test("CDP message includes the element's bounding rect", async () => {
 // The CDP click needs the element's center coordinates to dispatch the
 // mouse event. The message MUST carry `rect` (the BoundingClientRect).
    const sendMsg = vi.fn(async () => ({ ok: true }));
    installChromeMock(sendMsg);

    const button = document.createElement("button");
    document.body.appendChild(button);
    const state = stateWith(button);
    await executeAction({ type: "click", index: 1 }, state);

    expect(sendMsg).toHaveBeenCalledTimes(1);
    const msg = (sendMsg.mock.calls[0] as unknown[])[0] as { type: string; rect: unknown };
    expect(msg.type).toBe("CDP_CLICK");
    expect(msg.rect).toBeDefined();
 // `rect` is the result of el.getBoundingClientRect() — must have x/y/width/height.
    expect(typeof (msg.rect as DOMRect).x).toBe("number");
    expect(typeof (msg.rect as DOMRect).y).toBe("number");
    expect(typeof (msg.rect as DOMRect).width).toBe("number");
    expect(typeof (msg.rect as DOMRect).height).toBe("number");
  });

  test("when CDP fails, falls through to native el.click() (strategy 2)", async () => {
 // CDP-first does NOT mean CDP-only — when CDP returns `{ ok: false }`,
 // the cascade must continue to native. This proves the cascade ORDER
 // (CDP before native) rather than just CDP-only behavior.
    const sendMsg = vi.fn(async () => ({ ok: false, error: "debugger rejected" }));
    installChromeMock(sendMsg);

    const button = document.createElement("button");
    document.body.appendChild(button);
    let nativeClicked = false;
    button.addEventListener("click", () => { nativeClicked = true; });

    const state = stateWith(button);
    const result = await executeAction({ type: "click", index: 1 }, state);

 // CDP was tried first.
    expect(sendMsg).toHaveBeenCalledTimes(1);
    expect((sendMsg.mock.calls[0] as unknown[])[0]).toMatchObject({ type: "CDP_CLICK" });
 // Native was tried AFTER CDP failed (cascade continued).
    expect(nativeClicked).toBe(true);
 // Result reports native as the strategy used (CDP failed).
    expect(result.success).toBe(true);
    expect(result.message).toContain("native");
    expect(result.message).not.toContain("CDP");
  });

  test("STOP while CDP is pending never falls through to a native click", async () => {
    let settleCdp!: (value: unknown) => void;
    const sendMsg = vi.fn(() => new Promise((resolve) => { settleCdp = resolve; }));
    installChromeMock(sendMsg);

    const button = document.createElement("button");
    document.body.appendChild(button);
    const nativeClick = vi.spyOn(button, "click");
    const controller = new AbortController();
    const pending = executeAction({ type: "click", index: 1 }, stateWith(button), controller.signal);
    await vi.waitFor(() => expect(sendMsg).toHaveBeenCalledTimes(1));

    controller.abort(new DOMException("Stopped", "AbortError"));
    settleCdp({ ok: false, error: "stale run dispatch token" });
    const result = await pending;

    expect(result.success).toBe(false);
    expect(result.message).toContain("AbortError");
    expect(nativeClick).not.toHaveBeenCalled();
  });

  test("a vision-coordinate CDP click carries cancellation and dispatch identity", async () => {
    let settleCdp!: (value: unknown) => void;
    const sendMsg = vi.fn(() => new Promise((resolve) => { settleCdp = resolve; }));
    installChromeMock(sendMsg);
    const controller = new AbortController();
    const token = { runId: "vision-run", dispatchRevision: 7 };
    const pending = executeAction(
      { type: "click", index: "v1" },
      stateWith(),
      controller.signal,
      false,
      undefined,
      token,
    );
    await vi.waitFor(() => expect(sendMsg).toHaveBeenCalledTimes(1));
    expect(sendMsg).toHaveBeenCalledWith(expect.objectContaining({
      type: "CDP_CLICK",
      visionIndex: "v1",
      token,
    }));

    controller.abort(new DOMException("Stopped", "AbortError"));
    settleCdp({ ok: true });
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.message).toContain("AbortError");
  });

  test("a pre-aborted direct action performs no synchronous DOM effect", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("Stopped", "AbortError"));
    const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});

    const result = await executeAction({ type: "scroll", down: true, pages: 1 }, stateWith());
    const abortedResult = await executeAction(
      { type: "scroll", down: true, pages: 1 },
      stateWith(),
      controller.signal,
    );

    expect(result).toBeDefined();
    scrollBy.mockClear();
    expect(abortedResult.success).toBe(false);
    expect(abortedResult.message).toContain("AbortError");
    expect(scrollBy).not.toHaveBeenCalled();
  });

  test("when chrome.runtime.id is absent (test/demo context), CDP is skipped — native first (regression guard)", async () => {
 // The CDP guard is `chrome.runtime?.id`. In test/demo context (no chrome
 // global), CDP must be skipped entirely and native el.click() runs first.
 // This test pins the guard so a future refactor that always-tries CDP
 // (e.g. by dropping the `chrome.runtime?.id` check) would break tests
 // that don't mock chrome — making the regression immediately visible.
 // No chrome global installed — simulate non-extension context.
    delete (globalThis as unknown as { chrome?: unknown }).chrome;

    const button = document.createElement("button");
    document.body.appendChild(button);
    let nativeClicked = false;
    button.addEventListener("click", () => { nativeClicked = true; });

    const state = stateWith(button);
    const result = await executeAction({ type: "click", index: 1 }, state);

    expect(nativeClicked).toBe(true);
    expect(result.success).toBe(true);
    expect(result.message).toContain("native");
    expect(result.message).not.toContain("CDP");
  });
});

// ─── coerceJudgement advisory flags ─────────────────────────────────────────
//
// `impossibleTask` / `reachedCaptcha` are advisory outputs of the
// judge — they must default to false when omitted and coerce lenient booleans
// exactly like `verdict` does. The fields remain surfaced (loop/helpers/judges
// decides what to do with them); these tests pin the coercion contract.

describe("judge-helpers: coerceJudgement advisory flags", () => {
  async function coerce(parsed: Record<string, unknown>) {
    const { coerceJudgement } = await import("../src/lib/agent/judge-helpers");
    return coerceJudgement(parsed);
  }

  test("missing verdict routes to null (unchanged contract)", async () => {
    expect(await coerce({ impossibleTask: true })).toBeNull();
  });

  test("omitted advisory flags default to false", async () => {
    const r = await coerce({ verdict: true });
    expect(r?.impossibleTask).toBe(false);
    expect(r?.reachedCaptcha).toBe(false);
  });

  test("lenient truthy strings coerce flags to true", async () => {
    const r = await coerce({ verdict: true, impossibleTask: "true", reachedCaptcha: "Yes" });
    expect(r?.impossibleTask).toBe(true);
    expect(r?.reachedCaptcha).toBe(true);
  });

  test("non-truthy values coerce flags to false", async () => {
    const r = await coerce({ verdict: true, impossibleTask: "maybe", reachedCaptcha: 0 });
    expect(r?.impossibleTask).toBe(false);
    expect(r?.reachedCaptcha).toBe(false);
  });

  test("flags are independent of the verdict value", async () => {
    const r = await coerce({ verdict: false, impossibleTask: 1 });
    expect(r?.verdict).toBe(false);
    expect(r?.impossibleTask).toBe(true);
  });
});

// ─── output-parser JSON-snippet redaction ───────────────────────────────────
//
// A JSON parse failure embeds a 200-char snippet of the model's own
// output in the error string. If that output echoed a credential, the snippet
// must be key-shape-redacted before the error reaches retry prompts / logs.

describe("output-parser-utils: JSON error snippet redaction", () => {
  test("a key-shaped credential in a failed parse snippet is masked", async () => {
    const { parseOutput } = await import("../src/lib/agent/output-parser-utils");
    const { z } = await import("zod");
    const schema = z.object({ completion: z.string() });

    const raw = '{"completion": "sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456", broken';
    const result = await parseOutput(schema, raw);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("[redacted]");
    expect(result.error).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456");
    // The raw payload is still preserved on the result for diagnostics.
    expect(result.raw).toBe(raw);
  });

  test("an ordinary parse failure keeps the human-readable snippet", async () => {
    const { parseOutput } = await import("../src/lib/agent/output-parser-utils");
    const { z } = await import("zod");
    const schema = z.object({ completion: z.string() });

    const raw = '{"completion": "almost", broken';
    const result = await parseOutput(schema, raw);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("JSON parse error");
    expect(result.error).toContain('"completion": "almost"');
  });
});

// ─── metrics-utils sanitizers ───────────────────────────────────────────────
//
// `sanitizeTokenCount` and `sanitizeCostUsd` are one sanitizer; both
// must accept finite numbers and reject anything else identically.

describe("metrics-utils sanitizers", () => {
  test("sanitizeTokenCount accepts finite numbers, rejects everything else", async () => {
    const { sanitizeTokenCount } = await import("../src/lib/agent/callbacks/metrics-utils");
    expect(sanitizeTokenCount(10)).toBe(10);
    expect(sanitizeTokenCount(0)).toBe(0);
    expect(sanitizeTokenCount(1.5)).toBe(1.5);
    expect(sanitizeTokenCount(Number.NaN)).toBeUndefined();
    expect(sanitizeTokenCount(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(sanitizeTokenCount("10")).toBeUndefined();
    expect(sanitizeTokenCount(null)).toBeUndefined();
    expect(sanitizeTokenCount(undefined)).toBeUndefined();
  });

  test("sanitizeCostUsd behaves identically (shared sanitizer)", async () => {
    const { sanitizeCostUsd } = await import("../src/lib/agent/callbacks/metrics-utils");
    expect(sanitizeCostUsd(0.01)).toBe(0.01);
    expect(sanitizeCostUsd(Number.NaN)).toBeUndefined();
    expect(sanitizeCostUsd(Number.NEGATIVE_INFINITY)).toBeUndefined();
    expect(sanitizeCostUsd("0.01")).toBeUndefined();
  });
});

// ─── AgentMetricsCallback ───────────────────────────────────────────────────
//
// The metrics callback has zero direct tests. Pin the phase-attribution
// state machine, the positive/negative gap reconciliation, the sanitization
// paths, and the deep-copy snapshot guarantee.

describe("callbacks/metrics: AgentMetricsCallback", () => {
  const ctx = { task: "t", step: 0, history: [] };

  async function makeMetrics() {
    const { AgentMetricsCallback } = await import("../src/lib/agent/callbacks/metrics");
    return new AgentMetricsCallback();
  }

  function llmEnd(tokensIn?: number, tokensOut?: number) {
    return {
      content: "x",
      usage:
        tokensIn === undefined && tokensOut === undefined
          ? undefined
          : {
              tokensIn: tokensIn ?? 0,
              tokensOut: tokensOut ?? 0,
              model: "m",
              costUsd: 0,
            },
    };
  }

  test("initial snapshot is all zeros", async () => {
    const cb = await makeMetrics();
    const m = cb.getMetrics();
    expect(m.totalSteps).toBe(0);
    expect(m.totalActions).toBe(0);
    expect(m.totalTokensIn).toBe(0);
    expect(m.totalTokensOut).toBe(0);
    expect(m.totalCostUsd).toBe(0);
    expect(m.llmByPhase.planner.calls).toBe(0);
    expect(m.llmByPhase.navigator.calls).toBe(0);
    expect(m.llmByPhase.unattributed.calls).toBe(0);
  });

  test("first LLM call attributes to planner; plannerStep/stepStart/stepEnd steer the state machine", async () => {
    const cb = await makeMetrics();

    cb.onLLMEnd(ctx, llmEnd(100, 20)); // first call → planner
    expect(cb.getMetrics().llmByPhase.planner.calls).toBe(1);

    cb.onPlannerStep();
    cb.onLLMEnd(ctx, llmEnd(50, 10)); // after planner step → navigator
    expect(cb.getMetrics().llmByPhase.navigator.calls).toBe(1);

    cb.onStepStart();
    cb.onLLMEnd(ctx, llmEnd(5, 2)); // inside a step → navigator
    expect(cb.getMetrics().llmByPhase.navigator.calls).toBe(2);

    cb.onStepEnd(ctx, []);
    cb.onLLMEnd(ctx, llmEnd(1, 1)); // between steps → planner guess
    expect(cb.getMetrics().llmByPhase.planner.calls).toBe(2);

    const m = cb.getMetrics();
    expect(m.totalTokensIn).toBe(156);
    expect(m.totalTokensOut).toBe(33);
  });

  test("onStepEnd tallies steps and per-action-type success/failure", async () => {
    const cb = await makeMetrics();
    const actions = [
      { action: { type: "click" }, success: true },
      { action: { type: "click" }, success: false },
      { action: { type: "type" }, success: true },
    ];
    cb.onStepEnd(ctx, actions as never);

    const m = cb.getMetrics();
    expect(m.totalSteps).toBe(1);
    expect(m.totalActions).toBe(3);
    expect(m.actionsByType.click).toEqual({ total: 2, successes: 1, failures: 1 });
    expect(m.actionsByType.type).toEqual({ total: 1, successes: 1, failures: 0 });
  });

  test("positive token gap on run end is attributed to the unattributed bucket", async () => {
    const cb = await makeMetrics();
    cb.onLLMEnd(ctx, llmEnd(100, 20)); // planner captured 100/20

    cb.onRunEnd({
      success: true,
      text: "ok",
      stepCount: 1,
      totalCostUsd: 0,
      totalTokensIn: 300,
      totalTokensOut: 80,
    });

    const m = cb.getMetrics();
    expect(m.totalTokensIn).toBe(300);
    expect(m.totalTokensOut).toBe(80);
    // 300 - 100 = 200 unattributed in; 80 - 20 = 60 unattributed out.
    expect(m.llmByPhase.unattributed.tokensIn).toBe(200);
    expect(m.llmByPhase.unattributed.tokensOut).toBe(60);
    expect(m.llmByPhase.unattributed.calls).toBe(1);
    // Invariant: planner + navigator + unattributed == authoritative total.
    expect(m.llmByPhase.planner.tokensIn + m.llmByPhase.unattributed.tokensIn).toBe(300);
  });

  test("negative token gap warns and records a negative unattributed delta", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const cb = await makeMetrics();
      cb.onLLMEnd(ctx, llmEnd(100, 20)); // accumulated 100/20

      cb.onRunEnd({
        success: true,
        text: "ok",
        stepCount: 1,
        totalCostUsd: 0,
        totalTokensIn: 50,
        totalTokensOut: 10,
      });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const m = cb.getMetrics();
      expect(m.llmByPhase.unattributed.tokensIn).toBe(-50);
      expect(m.llmByPhase.unattributed.tokensOut).toBe(-10);
      // Invariant restored: 100 + (-50) == 50 authoritative.
      expect(m.llmByPhase.planner.tokensIn + m.llmByPhase.unattributed.tokensIn).toBe(50);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("sanitization: non-numeric usage is warned and skipped", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const cb = await makeMetrics();
      cb.onLLMEnd(ctx, { content: "x", usage: { tokensIn: Number.NaN, tokensOut: 5, model: "m", costUsd: 0 } } as never);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(cb.getMetrics().llmByPhase.planner.calls).toBe(0);
      expect(cb.getMetrics().totalTokensIn).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("onRunEnd overwrites cost with the authoritative result", async () => {
    const cb = await makeMetrics();
    cb.onCost(ctx, { tokensIn: 1, tokensOut: 1, model: "m", costUsd: 0.25 });
    expect(cb.getMetrics().totalCostUsd).toBe(0.25);

    cb.onRunEnd({ success: true, text: "ok", stepCount: 0, totalCostUsd: 1.5, totalTokensIn: 0, totalTokensOut: 0 });
    expect(cb.getMetrics().totalCostUsd).toBe(1.5);
  });

  test("run-end stepCount reconciliation takes the max", async () => {
    const cb = await makeMetrics();
    cb.onStepEnd(ctx, []);
    cb.onStepEnd(ctx, []);
    expect(cb.getMetrics().totalSteps).toBe(2);

    cb.onRunEnd({ success: true, text: "ok", stepCount: 5, totalCostUsd: 0, totalTokensIn: 0, totalTokensOut: 0 });
    expect(cb.getMetrics().totalSteps).toBe(5);
  });

  test("getMetrics returns a deep copy — mutating it does not affect the callback", async () => {
    const cb = await makeMetrics();
    cb.onStepEnd(ctx, [{ action: { type: "click" }, success: true }] as never);

    const snap = cb.getMetrics();
    snap.actionsByType.click!.total = 99;
    snap.totalSteps = 99;
    snap.llmByPhase.planner.tokensIn = 99;

    const fresh = cb.getMetrics();
    expect(fresh.actionsByType.click!.total).toBe(1);
    expect(fresh.totalSteps).toBe(1);
    expect(fresh.llmByPhase.planner.tokensIn).toBe(0);
  });

  test("loop warnings, compactions, and error recoverability are counted", async () => {
    const cb = await makeMetrics();
    cb.onLoopWarning();
    cb.onLoopWarning();
    cb.onCompaction();
    cb.onError(ctx, "transient", true);
    cb.onError(ctx, "fatal", false);

    const m = cb.getMetrics();
    expect(m.loopWarnings).toBe(2);
    expect(m.compactions).toBe(1);
    expect(m.errors).toEqual({ total: 2, recoverable: 1, fatal: 1 });
  });
});
