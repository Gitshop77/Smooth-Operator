/**
 * log-renderer.ts tests — AGENT_EVENT handling + cost/token tracking.
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from "vitest";

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
    <div id="statusCenter" hidden></div>
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

  test("renders error event machine code + recovery hint when present", () => {
    addLogRow({
      type: "error", step: 1, recoverable: true,
      message: "Rate limit hit. The agent will retry automatically.",
      code: "rate_limited",
      recovery: "Wait a few seconds; the agent will retry automatically.",
    }, "t0");
    const msgs = chatMessages.querySelectorAll(".msg-system");
    expect(msgs.length).toBe(1);
    expect(msgs[0].textContent).toContain("Rate limit hit. The agent will retry automatically.");
    expect(msgs[0].textContent).toContain("[rate_limited]");
    expect(msgs[0].textContent).toContain("Wait a few seconds; the agent will retry automatically.");
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

  test("run-start marks the run as running (Stop enabled, input disabled)", () => {
    addLogRow({ type: "run-start", task: "scheduled task" }, "t0");
    const send = document.getElementById("sendBtn") as HTMLButtonElement;
    const stop = document.getElementById("stopBtn") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(stop.disabled).toBe(false);
  });

  test("done resets the running state", () => {
    addLogRow({ type: "run-start", task: "t" }, "t0");
    addLogRow({ type: "done", step: 1, success: true, text: "ok" }, "t1");
    const send = document.getElementById("sendBtn") as HTMLButtonElement;
    const stop = document.getElementById("stopBtn") as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    expect(stop.disabled).toBe(true);
  });

  test("error event text is key-redacted before rendering", () => {
    const rawKey = "sk-ant-api03-abcdefghijklmnop";
    addLogRow(
      { type: "error", step: 1, recoverable: false, message: `401: Invalid API key: ${rawKey}` },
      "t0",
    );
    const msgs = chatMessages.querySelectorAll(".msg-system");
    expect(msgs.length).toBe(1);
    expect(msgs[0].textContent).toContain("[REDACTED]");
    expect(msgs[0].textContent).not.toContain(rawKey);
    expect(msgs[0].textContent).not.toContain("sk-ant-api03");
  });

  test("cost events accumulate totals, render, and persist", () => {
    addLogRow({ type: "cost", step: 1, tokensIn: 100, tokensOut: 50, costUsd: 0.5, model: "m" }, "t0");
    addLogRow({ type: "cost", step: 2, tokensIn: 10, tokensOut: 40, costUsd: 0.25, model: "m" }, "t1");
    expect(costLabel.textContent).toBe("$0.7500");
    expect(tokenLabel.textContent).toBe("200 tokens");
    expect(store.__oc_costUsd).toBe(0.75);
    expect(store.__oc_tokens).toBe(200);
    const center = document.getElementById("statusCenter") as HTMLElement;
    expect(center.hidden).toBe(false);
  });

  test("malformed cost events are dropped without touching the totals", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      addLogRow({ type: "cost", step: 1, tokensIn: Number.NaN, tokensOut: 50, costUsd: 0.5, model: "m" }, "t0");
      expect(costLabel.textContent).toBe("$0.0000");
      expect(tokenLabel.textContent).toBe("0 tokens");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("log-renderer listener gate", () => {
  type Sender = { id?: string; tab?: unknown; url?: string };
  type Listener = (
    msg: unknown,
    sender: Sender,
    sendResponse: (r: unknown) => void,
  ) => unknown;

  let gateListener: Listener | null = null;
  let chatMessages: HTMLElement;

  function setupGateGlobals(): void {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: {
        lastError: undefined,
        id: "test",
        onMessage: { addListener: (cb: Listener) => { gateListener = cb; } },
        sendMessage: (_msg: unknown, _cb?: (res: unknown) => void) => {},
      },
      storage: {
        local: {
          get: (_k: unknown, cb: (res: unknown) => void) => cb({}),
          set: (_v: Record<string, unknown>) => Promise.resolve(),
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

  function countMsgs(): number {
    return chatMessages.querySelectorAll(".msg-system").length;
  }

  beforeAll(async () => {
    vi.resetModules();
    setupGateGlobals();
    await import("../src/extension/sidepanel/log-renderer");
    chatMessages = document.getElementById("chatMessages") as HTMLElement;
  });

  beforeEach(() => {
    chatMessages.innerHTML = "";
  });

  test("accepts a valid AGENT_EVENT envelope from the extension", () => {
    const ret = gateListener!(
      { type: "AGENT_EVENT", event: { type: "info", message: "hello" }, time: "t0" },
      { id: "test" },
      () => {},
    );
    expect(ret).toBe(false);
    expect(countMsgs()).toBe(1);
    expect(chatMessages.textContent).toContain("hello");
  });

  test("drops an envelope whose event fails the gate", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      gateListener!(
        { type: "AGENT_EVENT", event: { type: "mystery" }, time: "t0" },
        { id: "test" },
        () => {},
      );
      gateListener!(
        { type: "AGENT_EVENT", event: { type: "info", message: "x" }, time: 42 },
        { id: "test" },
        () => {},
      );
      expect(countMsgs()).toBe(0);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("ignores non-AGENT_EVENT messages", () => {
    gateListener!({ type: "STATUS" }, { id: "test" }, () => {});
    expect(countMsgs()).toBe(0);
  });

  test("rejects senders that are not this extension's pages", () => {
    gateListener!(
      { type: "AGENT_EVENT", event: { type: "info", message: "x" }, time: "t0" },
      { id: "other-ext" },
      () => {},
    );
    gateListener!(
      { type: "AGENT_EVENT", event: { type: "info", message: "x" }, time: "t0" },
      { id: "test", tab: { id: 1 } },
      () => {},
    );
    gateListener!(
      { type: "AGENT_EVENT", event: { type: "info", message: "x" }, time: "t0" },
      { id: "test", url: "chrome-extension://test/options.html" },
      () => {},
    );
    expect(countMsgs()).toBe(0);
  });
});

describe("log-renderer totals restore", () => {
  let restoreTotalsFromStorage: () => void;
  let clearRunTotals: () => void;
  let pendingGets: Array<(res: Record<string, unknown>) => void>;
  let costLabel: HTMLElement;
  let tokenLabel: HTMLElement;

  function setupDeferredGlobals(): void {
    pendingGets = [];
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: {
        lastError: undefined,
        id: "test",
        onMessage: { addListener: () => {} },
        sendMessage: (_msg: unknown, _cb?: (res: unknown) => void) => {},
      },
      storage: {
        local: {
          get: (_k: unknown, cb: (res: Record<string, unknown>) => void) => {
            pendingGets.push(cb);
          },
          set: () => Promise.resolve(),
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
      <div id="statusCenter" hidden></div>
    `;
  }

  beforeEach(async () => {
    vi.resetModules();
    setupDeferredGlobals();
    const mod = await import("../src/extension/sidepanel/log-renderer");
    restoreTotalsFromStorage = mod.restoreTotalsFromStorage;
    clearRunTotals = mod.clearRunTotals;
    costLabel = document.getElementById("costLabel") as HTMLElement;
    tokenLabel = document.getElementById("tokenLabel") as HTMLElement;
  });

  test("restore applies a stored snapshot when no clear intervened", () => {
    // pendingGets[0] is the elements-init settings read; [1] is the restore read.
    restoreTotalsFromStorage();
    pendingGets[1]({ __oc_costUsd: 5, __oc_tokens: 100 });
    expect(costLabel.textContent).toBe("$5.0000");
    expect(tokenLabel.textContent).toBe("100 tokens");
  });

  test("clearRunTotals landing mid-restore wins over the stale snapshot", () => {
    restoreTotalsFromStorage();
    clearRunTotals();
    pendingGets[1]({ __oc_costUsd: 5, __oc_tokens: 100 });
    expect(costLabel.textContent).toBe("$0.0000");
    expect(tokenLabel.textContent).toBe("0 tokens");
  });
});
