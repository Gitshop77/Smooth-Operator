/**
 * Humanized input timing (S4):
 * - `cdpTypeText` — per-character `Input.dispatchKeyEvent` typing with
 *   bounded human-like delays (`max(0.02, interval + uniform(-0.03, 0.05))`
 *   seconds, interval default 0.08).
 * - `handleInput` with `humanized: true` — OPT-IN ONLY: the element is still
 *   resolved/focused/cleared content-side (React-compatible native setter
 *   path), then the per-character typing is delegated to the service worker,
 *   which types via the browser's input pipeline (browser-trusted events).
 * - The SW-side `input` case in `handleTabAction` only fires for humanized
 *   input; plain input stays on the instant-set content-script path.
 *
 * Contract: humanized typing lands the same value as instant-set, with every
 * character dispatched in order and every delay inside the human bounds.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { cdpTypeText } from "../src/lib/agent/cdp-controller";
import { handleInput } from "../src/lib/agent/tools/handlers/input";
import { handleTabAction } from "../src/extension/background/tab-manager";
import { checkUrlAllowedWithDomainConfig } from "@/lib/agent/tools/helpers/domain-config";
import { makeState } from "./helpers/make-state";
import type { RunState } from "../src/extension/background/state-store";
import type { AgentAction } from "@/lib/agent/types";

vi.mock("@/lib/agent/tools/helpers/domain-config", () => ({
  checkUrlAllowedWithDomainConfig: vi.fn(),
}));

let sendCommand: ReturnType<typeof vi.fn>;

function installDebuggerStub(): void {
  sendCommand = vi.fn(async () => {});
  (globalThis as unknown as Record<string, unknown>).chrome = {
    debugger: {
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand,
    },
  };
}

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).chrome;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─── cdpTypeText ────────────────────────────────────────────────────────────

describe("cdpTypeText", () => {
  beforeEach(installDebuggerStub);

  test("dispatches one keyDown+keyUp per character; concatenated text equals the input", async () => {
    vi.useFakeTimers();
    const p = cdpTypeText(7, "Hi!");
    await vi.advanceTimersByTimeAsync(5000);
    await p;

    const keyEvents = sendCommand.mock.calls
      .filter((c) => c[1] === "Input.dispatchKeyEvent")
      .map((c) => c[2] as { type: string; key?: string; text?: string });
    expect(keyEvents.length).toBe(6); // keyDown + keyUp per character
    const downs = keyEvents.filter((e) => e.type === "keyDown");
    expect(downs.map((e) => e.text).join("")).toBe("Hi!");
    for (const d of downs) {
      expect(d.key).toBe(d.text);
    }
    expect(keyEvents.filter((e) => e.type === "keyUp").length).toBe(3);
  });

  test("per-character delays stay inside the human bounds", async () => {
    vi.useFakeTimers();
    const timerSpy = vi.spyOn(globalThis, "setTimeout");
    const p = cdpTypeText(7, "abc", { intervalMs: 80 });
    await vi.advanceTimersByTimeAsync(5000);
    await p;

    const delays = timerSpy.mock.calls.map((c) => c[1] as number);
    expect(delays.length).toBe(3); // one pre-character pause per character
    // max(0.02, 0.08 + uniform(-0.03, 0.05)) seconds → [50, 130] ms.
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(50);
      expect(d).toBeLessThanOrEqual(130);
    }
  });

  test("empty text dispatches nothing", async () => {
    vi.useFakeTimers();
    await cdpTypeText(7, "");
    expect(sendCommand).not.toHaveBeenCalled();
  });
});

// ─── handleInput humanized (content side) ───────────────────────────────────

describe("handleInput with humanized:true", () => {
  let sendMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = `<input id="t" value="old">`;
    sendMessage = vi.fn(async () => ({ ok: true, success: true, message: "typed 2 chars via CDP" }));
    (globalThis as unknown as Record<string, unknown>).chrome = {
      runtime: { id: "ext-id", sendMessage },
    };
  });

  test("focuses and clears content-side, then delegates the same text to the SW", async () => {
    const input = document.querySelector<HTMLInputElement>("#t")!;
    const state = makeState({ selectorMap: { 1: input } });
    const ctx = {
      state,
      beforeUrl: location.href,
      beforeFingerprint: "fp",
    };

    const res = await handleInput(ctx, {
      type: "input",
      index: 1,
      text: "hello",
      clear: true,
      humanized: true,
    });

    expect(res.success).toBe(true);
    // The field is cleared content-side so the SW typing lands the exact text.
    expect(input.value).toBe("");
    const msg = sendMessage.mock.calls[0][0] as { type: string; action: AgentAction };
    expect(msg.type).toBe("TAB_ACTION");
    expect(msg.action.type).toBe("input");
    expect((msg.action as { humanized?: boolean }).humanized).toBe(true);
    expect((msg.action as { text: string }).text).toBe("hello");
  });

  test("humanized typing lands the same value the instant path would set", async () => {
    const input = document.querySelector<HTMLInputElement>("#t")!;
    const state = makeState({ selectorMap: { 1: input } });
    const ctx = {
      state,
      beforeUrl: location.href,
      beforeFingerprint: "fp",
    };

    // Instant-set baseline on a fresh field.
    await handleInput(ctx, { type: "input", index: 1, text: "world", clear: true });
    const instantValue = input.value;
    expect(instantValue).toBe("world");

    // Humanized path: clear + delegate. The delegated text is identical and
    // the content-side clear guarantees the SW typing fills the same field.
    input.value = "old";
    const res = await handleInput(ctx, {
      type: "input",
      index: 1,
      text: "world",
      clear: true,
      humanized: true,
    });
    expect(res.success).toBe(true);
    expect(input.value).toBe("");
    expect((sendMessage.mock.calls[0][0] as { action: { text: string } }).action.text).toBe(
      instantValue,
    );
  });

  test("clears contenteditable content before delegating so typing lands the exact value", async () => {
    document.body.innerHTML = `<div contenteditable="true" id="ed">old text</div>`;
    const ed = document.querySelector<HTMLDivElement>("#ed")!;
    // jsdom does not implement isContentEditable — simulate the browser
    // contract so the handler's editable check passes.
    Object.defineProperty(ed, "isContentEditable", { value: true, configurable: true });
    const state = makeState({ selectorMap: { 1: ed } });
    const ctx = {
      state,
      beforeUrl: location.href,
      beforeFingerprint: "fp",
    };

    const res = await handleInput(ctx, {
      type: "input",
      index: 1,
      text: "new text",
      clear: true,
      humanized: true,
    });
    expect(res.success).toBe(true);
    // The contenteditable is emptied content-side — otherwise CDP would type
    // at the caret over the old content and report success with a wrong value.
    expect(ed.textContent).toBe("");
    const msg = sendMessage.mock.calls[0][0] as { type: string; action: AgentAction };
    expect(msg.type).toBe("TAB_ACTION");
    expect((msg.action as { text: string }).text).toBe("new text");
  });

  test("append mode (clear:false) does not wipe existing content before typing", async () => {
    const input = document.querySelector<HTMLInputElement>("#t")!;
    const state = makeState({ selectorMap: { 1: input } });
    const ctx = {
      state,
      beforeUrl: location.href,
      beforeFingerprint: "fp",
    };
    const res = await handleInput(ctx, {
      type: "input",
      index: 1,
      text: " more",
      clear: false,
      humanized: true,
    });
    expect(res.success).toBe(true);
    expect(input.value).toBe("old");
  });

  test("without an extension context, humanized input fails honestly", async () => {
    delete (globalThis as unknown as Record<string, unknown>).chrome;
    const input = document.querySelector<HTMLInputElement>("#t")!;
    const state = makeState({ selectorMap: { 1: input } });
    const ctx = {
      state,
      beforeUrl: location.href,
      beforeFingerprint: "fp",
    };

    const res = await handleInput(ctx, {
      type: "input",
      index: 1,
      text: "hello",
      clear: true,
      humanized: true,
    });
    expect(res.success).toBe(false);
    expect(res.message).toContain("not supported in the current mode");
  });

  test("a failed SW response surfaces as a failed action", async () => {
    sendMessage.mockResolvedValue({ ok: false, error: "no active run" });
    const input = document.querySelector<HTMLInputElement>("#t")!;
    const state = makeState({ selectorMap: { 1: input } });
    const ctx = {
      state,
      beforeUrl: location.href,
      beforeFingerprint: "fp",
    };

    const res = await handleInput(ctx, {
      type: "input",
      index: 1,
      text: "hello",
      clear: true,
      humanized: true,
    });
    expect(res.success).toBe(false);
    expect(res.message).toContain("no active run");
  });
});

// ─── SW-side input case ─────────────────────────────────────────────────────

describe("handleTabAction — input case", () => {
  let chromeMock: {
    tabs: {
      get: ReturnType<typeof vi.fn>;
      query: ReturnType<typeof vi.fn>;
      sendMessage: ReturnType<typeof vi.fn>;
    };
    debugger: {
      attach: ReturnType<typeof vi.fn>;
      detach: ReturnType<typeof vi.fn>;
      sendCommand: ReturnType<typeof vi.fn>;
    };
  };

  function installChrome(): void {
    chromeMock = {
      tabs: {
        get: vi.fn(async () => ({ id: 1, status: "complete", url: "https://example.com" })),
        query: vi.fn(async () => []),
        sendMessage: vi.fn(async () => ({ ok: true })),
      },
      debugger: {
        attach: vi.fn(async () => {}),
        detach: vi.fn(async () => {}),
        sendCommand: vi.fn(async () => {}),
      },
    };
    (globalThis as unknown as Record<string, unknown>).chrome = chromeMock;
  }

  const runState: RunState = {
    task: "t",
    maxSteps: 10,
    mode: "standard",
    startTabId: 1,
    currentTabId: 1,
    step: 0,
    active: true,
    abortRequested: false,
  };

  beforeEach(() => {
    installChrome();
    (checkUrlAllowedWithDomainConfig as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => ({ allowed: true }),
    );
  });

  test("humanized input types every character via CDP on the run's current tab", async () => {
    vi.useFakeTimers();
    const p = handleTabAction(
      { type: "input", index: 1, text: "hi", clear: true, humanized: true } as never,
      runState,
    );
    await vi.advanceTimersByTimeAsync(2000);
    const res = await p;

    expect(res.handled).toBe(true);
    expect(res.success).toBe(true);
    expect(res.message).toContain("typed");
    const keyEvents = chromeMock.debugger.sendCommand.mock.calls.filter(
      (c) => c[1] === "Input.dispatchKeyEvent",
    );
    expect(keyEvents.length).toBe(4); // keyDown + keyUp per character
    const texts = keyEvents
      .map((c) => (c[2] as { text?: string }).text)
      .filter((t): t is string => typeof t === "string");
    expect(texts.join("")).toBe("hi");
  });

  test("plain input is NOT intercepted by the SW (content-script path owns it)", async () => {
    const res = await handleTabAction(
      { type: "input", index: 1, text: "hi", clear: true } as never,
      runState,
    );
    expect(res.handled).toBe(false);
    expect(chromeMock.debugger.sendCommand).not.toHaveBeenCalled();
  });
});
