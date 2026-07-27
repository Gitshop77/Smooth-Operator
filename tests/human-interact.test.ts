/**
 * HUMAN_INTERACT payload validator in `sidepanel/human-interact.ts`.
 *
 * `human-interact.ts` imports `chat-renderer` (which pulls the side-panel
 * element refs via `elements.ts`) and registers a `chrome.runtime.onMessage`
 * listener at import time, so we stub `chrome` and create the required ids
 * before the dynamic import.
 */

import { describe, test, expect, vi, beforeAll } from "vitest";

type Sender = { id?: string; tab?: unknown; url?: string };
type Listener = (
  msg: unknown,
  sender: Sender,
  sendResponse: (r: unknown) => void,
) => unknown;

// Captured at module-import time so the trust-boundary tests can drive the
// listener directly with crafted senders.
let listener: Listener | null = null;

function setupGlobals(): void {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      lastError: undefined,
      id: "test",
      onMessage: { addListener: (cb: Listener) => { listener = cb; } },
      sendMessage: (_msg: unknown, cb?: (res: unknown) => void) => {
        cb?.(undefined);
      },
    },
    storage: {
      local: { get: () => {}, set: () => Promise.resolve(), remove: () => Promise.resolve() },
      session: { get: () => {}, set: () => {}, remove: () => {} },
    },
  };

  document.body.innerHTML = `
    <div id="chatMessages"></div>
    <input id="messageInput" />
    <button id="sendBtn"></button>
    <button id="stopBtn"></button>
    <span id="costLabel">$0.0000</span>
    <span id="tokenLabel">0 tokens</span>
    <span id="statusDot" data-status="idle"></span>
    <span id="statusLabel">idle</span>
    <div id="takeoverBanner" hidden></div>
    <div id="takeoverReason"></div>
    <button id="resumeBtn"></button>
  `;
}

describe("human-interact parseHumanRequest", () => {
  let parseHumanRequest: (msg: unknown) => { mode: string; message: string } | null;

  beforeAll(async () => {
    setupGlobals();
    const mod = await import("../src/extension/sidepanel/human-interact");
    parseHumanRequest = mod.parseHumanRequest;
  });

  test("rejects non-object / non-string mode", () => {
    // Malformed / unusable payloads all yield null (treated as a no-op cancel).
    expect(parseHumanRequest({ request: { mode: 123 } })).toBeNull();
    expect(parseHumanRequest({})).toBeNull();
    expect(parseHumanRequest(null)).toBeNull();
    expect(parseHumanRequest(undefined)).toBeNull();
    expect(parseHumanRequest("x")).toBeNull();
    expect(parseHumanRequest(42)).toBeNull();
    expect(parseHumanRequest({ request: "x" })).toBeNull();
  });

  test("coerces a non-string message to empty string", () => {
    expect(parseHumanRequest({ request: { mode: "confirm", message: {} } })).toEqual({
      mode: "confirm",
      message: "",
    });
  });

  test("accepts a valid input request", () => {
    const r = parseHumanRequest({ request: { mode: "input", message: "hi" } });
    expect(r?.mode).toBe("input");
    expect(r?.message).toBe("hi");
  });
});

describe("HUMAN_INTERACT listener trust boundary", () => {
  beforeAll(async () => {
    // Self-contained setup: re-import the module against a fresh chrome stub so
    // this describe block does not silently depend on the parseHumanRequest
    // describe's beforeAll having run first.
    vi.resetModules();
    setupGlobals();
    await import("../src/extension/sidepanel/human-interact");
  });

  test("rejects a sender whose id is not the extension id", () => {
    const sendResponse = vi.fn();
    const ret = listener!(
      { type: "HUMAN_INTERACT", request: { mode: "confirm", message: "x" } },
      { id: "other-ext" },
      sendResponse,
    );
    expect(ret).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  test("rejects a sender carrying a tab (content script)", () => {
    const sendResponse = vi.fn();
    const ret = listener!(
      { type: "HUMAN_INTERACT", request: { mode: "confirm", message: "x" } },
      { id: "test", tab: { id: 1 } },
      sendResponse,
    );
    expect(ret).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  test("rejects a sender carrying a url (options/popup/peer sidepanel)", () => {
    const sendResponse = vi.fn();
    const ret = listener!(
      { type: "HUMAN_INTERACT", request: { mode: "confirm", message: "x" } },
      { id: "test", url: "chrome-extension://test/options.html" },
      sendResponse,
    );
    expect(ret).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  test("does not throw on a valid SW sender with a malformed payload", () => {
    const sendResponse = vi.fn();
    expect(() =>
      listener!(
        { type: "HUMAN_INTERACT", request: { mode: 123 } },
        { id: "test" },
        sendResponse,
      ),
    ).not.toThrow();
    expect(sendResponse).toHaveBeenCalledWith({ mode: "cancelled" });
  });
});
