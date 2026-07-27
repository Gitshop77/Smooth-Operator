/**
 * log-renderer.ts tests — AGENT_EVENT handling + cost/token tracking.
 */

import { describe, test, expect, beforeAll, beforeEach } from "vitest";

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

describe("log-renderer", () => {
  let clearRunTotals: () => void;
  let addLogRow: (event: unknown, time: string) => void;
  let costLabel: HTMLElement;
  let tokenLabel: HTMLElement;
  let chatMessages: HTMLElement;

  beforeAll(async () => {
    setupGlobals();
    const mod = await import("../src/extension/sidepanel/log-renderer");
    clearRunTotals = mod.clearRunTotals;
    addLogRow = mod.addLogRow as unknown as (event: unknown, time: string) => void;
    costLabel = document.getElementById("costLabel") as HTMLElement;
    tokenLabel = document.getElementById("tokenLabel") as HTMLElement;
    chatMessages = document.getElementById("chatMessages") as HTMLElement;
  });

  beforeEach(() => {
    clearRunTotals();
    chatMessages.innerHTML = "";
  });

  test("clearRunTotals resets cost and token labels", () => {
    expect(costLabel.textContent).toBe("$0.0000");
    expect(tokenLabel.textContent).toBe("0 tokens");
  });

  test("renders run-start as a system message", () => {
    addLogRow({ type: "run-start", task: "test task" }, "t0");
    const msgs = chatMessages.querySelectorAll(".msg-system");
    expect(msgs.length).toBe(1);
    expect(msgs[0].textContent).toContain("test task");
  });

  test("renders done event as a system message", () => {
    addLogRow({ type: "done", success: true, text: "completed" }, "t0");
    const msgs = chatMessages.querySelectorAll(".msg-system");
    expect(msgs.length).toBe(1);
    expect(msgs[0].textContent).toContain("Task completed");
  });

  test("renders error event as a system message", () => {
    addLogRow({ type: "error", step: 1, recoverable: false, message: "something broke" }, "t0");
    const msgs = chatMessages.querySelectorAll(".msg-system");
    expect(msgs.length).toBe(1);
    expect(msgs[0].textContent).toContain("something broke");
  });

  test("renders info event as a system message", () => {
    addLogRow({ type: "info", message: "hello" }, "t0");
    const msgs = chatMessages.querySelectorAll(".msg-system");
    expect(msgs.length).toBe(1);
    expect(msgs[0].textContent).toContain("hello");
  });

  test("renders action event as a system message", () => {
    addLogRow({ type: "action", step: 1, index: 1, total: 1, name: "click", description: "click the button" }, "t0");
    const msgs = chatMessages.querySelectorAll(".msg-system");
    expect(msgs.length).toBe(1);
    expect(msgs[0].textContent).toContain("click the button");
  });

  test("renders thinking event as a system message", () => {
    addLogRow({ type: "thinking", step: 1, nextGoal: "find the login button", text: "looking for it" }, "t0");
    const msgs = chatMessages.querySelectorAll(".msg-system");
    expect(msgs.length).toBe(1);
    expect(msgs[0].textContent).toContain("find the login button");
  });

  test("does not render empty thinking events", () => {
    addLogRow({ type: "thinking", step: 1, nextGoal: "", text: "" }, "t0");
    const msgs = chatMessages.querySelectorAll(".msg-system");
    expect(msgs.length).toBe(0);
  });
});
