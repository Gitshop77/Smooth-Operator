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
    // Production's sidepanel entry imports both siblings. Wire controls
    // explicitly now that log-renderer no longer reaches it through a cycle.
    await import("../src/extension/sidepanel/controls");
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

  /** Flush the chat renderer's microtask-batched DOM append. */
  async function flushChat(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  test("clearRunTotals resets cost and token labels", () => {
    expect(costLabel.textContent).toBe("$0.0000");
    expect(tokenLabel.textContent).toBe("0 tokens");
  });

  test("renders run-start as a system message", async () => {
    addLogRow({ type: "run-start", task: "test task" }, "t0");
    await flushChat();
    const msgs = chatMessages.querySelectorAll(".msg-system");
    expect(msgs.length).toBe(1);
    expect(msgs[0].textContent).toContain("test task");
  });

  test("renders the first zero-based loop event as user-visible step 1", async () => {
    addLogRow({ type: "navigator-step-start", step: 0, goal: "read" }, "t0");
    await flushChat();
    expect(chatMessages.textContent).toContain("Step 1");
    expect(chatMessages.textContent).not.toContain("Step 0");
  });

  test("renders done event as a system message", async () => {
    addLogRow({ type: "done", step: 1, success: true, text: "## Result\n\n**completed**" }, "t0");
    await flushChat();
    const msgs = chatMessages.querySelectorAll(".msg-system");
    expect(msgs.length).toBe(1);
    expect(msgs[0].textContent).toContain("Task completed");
    const answer = chatMessages.querySelector(".msg-assistant") as HTMLElement;
    expect(answer.querySelector("h2")?.textContent).toBe("Result");
    expect(answer.querySelector(".markdown-body strong")?.textContent).toBe("completed");
  });

  test("renders error event as a system message", async () => {
    addLogRow({ type: "error", step: 1, recoverable: false, message: "something broke" }, "t0");
    await flushChat();
    const msgs = chatMessages.querySelectorAll(".msg-system");
    expect(msgs.length).toBe(1);
    expect(msgs[0].textContent).toContain("something broke");
  });

  test("renders error event machine code + recovery hint when present", async () => {
    addLogRow({
      type: "error", step: 1, recoverable: true,
      message: "Rate limit hit. The agent will retry automatically.",
      code: "rate_limited",
      recovery: "Wait a few seconds; the agent will retry automatically.",
    }, "t0");
    await flushChat();
    const msgs = chatMessages.querySelectorAll(".msg-system");
    expect(msgs.length).toBe(1);
    expect(msgs[0].textContent).toContain("Rate limit hit. The agent will retry automatically.");
    expect(msgs[0].textContent).toContain("[rate_limited]");
    expect(msgs[0].textContent).toContain("Wait a few seconds; the agent will retry automatically.");
  });

  test("renders info event as a system message", async () => {
    addLogRow({ type: "info", message: "hello" }, "t0");
    await flushChat();
    const msgs = chatMessages.querySelectorAll(".msg-system");
    expect(msgs.length).toBe(1);
    expect(msgs[0].textContent).toContain("hello");
  });

  test("renders an action as a live tool activity card", async () => {
    addLogRow({ type: "action", step: 1, index: 1, total: 1, name: "click", description: "click the button" }, "t0");
    await flushChat();
    const msgs = chatMessages.querySelectorAll(".activity-tool");
    expect(msgs.length).toBe(1);
    expect(msgs[0].textContent).toContain("click the button");
  });

  test("renders every navigator reasoning field in an expanded activity card", async () => {
    addLogRow({
      type: "thinking", step: 1, nextGoal: "find the login button",
      text: "looking for it", evaluation: "page loaded", memory: "pricing found",
    }, "t0");
    await flushChat();
    const msgs = chatMessages.querySelectorAll(".activity-reasoning");
    expect(msgs.length).toBe(1);
    // The loop surfaces the model's redacted thinking in `text` — it takes
    // priority over `nextGoal` in the panel.
    expect(msgs[0].textContent).toContain("looking for it");
    expect(msgs[0].textContent).toContain("page loaded");
    expect(msgs[0].textContent).toContain("pricing found");
    expect(msgs[0].textContent).toContain("find the login button");
  });

  test("does not render empty thinking events", async () => {
    addLogRow({ type: "thinking", step: 1, nextGoal: "", text: "" }, "t0");
    await flushChat();
    const msgs = chatMessages.querySelectorAll(".msg-system");
    expect(msgs.length).toBe(0);
  });

  test("updates a live LLM prompt-processing card in place with timing and usage", async () => {
    addLogRow({
      type: "llm-call-start", step: 0, callId: "nav-1", role: "navigator",
      attempt: 1, startedAt: Date.now(),
      prompt: { historyItems: 4, requestChars: 12000, elementsChars: 8000, axTreeChars: 2000 },
    }, "t0");
    await flushChat();
    expect(chatMessages.querySelectorAll(".activity-card")).toHaveLength(1);
    expect(chatMessages.textContent).toContain("Thinking · preparing context");
    expect(chatMessages.textContent).toContain("DOM");

    addLogRow({
      type: "llm-call-progress", step: 0, callId: "nav-1", role: "navigator",
      attempt: 1, outputChars: 320, chunkCount: 18, elapsedMs: 7200,
    }, "t0");
    expect(chatMessages.textContent).toContain("Thinking · generating · 320 chars · 7.2s");
    expect(chatMessages.textContent).toContain("18 live chunks");

    addLogRow({
      type: "llm-call-end", step: 0, callId: "nav-1", role: "navigator",
      attempt: 1, status: "success", durationMs: 12340, outputChars: 900,
      parseValid: true, tokensIn: 6400, tokensOut: 420, reasoningTokens: 100,
      cachedInputTokens: 3000, model: "local-model",
    }, "t1");
    await flushChat();
    expect(chatMessages.querySelectorAll(".activity-card")).toHaveLength(1);
    expect(chatMessages.textContent).toContain("Completed · 12.3s");
    expect(chatMessages.textContent).toContain("reasoning");
    expect(chatMessages.textContent).toContain("cache read");
  });

  test("renders planner reasoning and highlights the active plan item", async () => {
    addLogRow({
      type: "planner-step", step: 2, decision: "continue",
      thinking: "Need evidence from two sources", goal: "Open the second source",
      plan: ["Collect source one", "Collect source two", "Synthesize"], currentPlanItem: 1,
    }, "t0");
    await flushChat();
    const card = chatMessages.querySelector(".activity-planner") as HTMLElement;
    expect(card.textContent).toContain("Need evidence from two sources");
    expect(card.querySelector(".activity-plan-current")?.textContent).toBe("Collect source two");
  });

  test("tool results update their matching call card instead of adding a duplicate", async () => {
    addLogRow({ type: "action", step: 1, index: 1, total: 1, name: "click", description: "Open pricing" }, "t0");
    await flushChat();
    addLogRow({ type: "action-result", step: 1, name: "click", success: true, message: "Pricing opened" }, "t1");
    await flushChat();
    expect(chatMessages.querySelectorAll(".activity-tool")).toHaveLength(1);
    expect(chatMessages.textContent).toContain("Succeeded");
    expect(chatMessages.textContent).toContain("Pricing opened");
  });

  test("run-start marks the run as running (Stop enabled, input disabled)", async () => {
    const { hydrateLegacyStatus } = await import("../src/extension/sidepanel/run-store");
    // The run-view store is the authority for control state. A
    // running store status enables Stop and disables Send/input.
    hydrateLegacyStatus(true);
    addLogRow({ type: "run-start", task: "scheduled task" }, "t0");
    const send = document.getElementById("sendBtn") as HTMLButtonElement;
    const stop = document.getElementById("stopBtn") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(stop.disabled).toBe(false);
  });

  test("done resets the running state without enabling blank Send", async () => {
    const { hydrateLegacyStatus } = await import("../src/extension/sidepanel/run-store");
    hydrateLegacyStatus(true);
    addLogRow({ type: "run-start", task: "t" }, "t0");
    addLogRow({ type: "done", step: 1, success: true, text: "ok" }, "t1");
    hydrateLegacyStatus(false);
    const send = document.getElementById("sendBtn") as HTMLButtonElement;
    const stop = document.getElementById("stopBtn") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(stop.disabled).toBe(true);
  });

  test("error event text is key-redacted before rendering", async () => {
    const rawKey = "sk-ant-api03-abcdefghijklmnop";
    addLogRow(
      { type: "error", step: 1, recoverable: false, message: `401: Invalid API key: ${rawKey}` },
      "t0",
    );
    await flushChat();
    const msgs = chatMessages.querySelectorAll(".msg-system");
    expect(msgs.length).toBe(1);
    expect(msgs[0].textContent).toContain("[REDACTED]");
    expect(msgs[0].textContent).not.toContain(rawKey);
    expect(msgs[0].textContent).not.toContain("sk-ant-api03");
  });

  test("cost events accumulate totals, render, and persist (debounced)", () => {
    addLogRow({ type: "cost", step: 1, tokensIn: 100, tokensOut: 50, costUsd: 0.5, model: "m" }, "t0");
    addLogRow({ type: "cost", step: 2, tokensIn: 10, tokensOut: 40, costUsd: 0.25, model: "m" }, "t1");
    expect(costLabel.textContent).toBe("$0.7500");
    expect(tokenLabel.textContent).toBe("200 tokens");
    // The storage IPC is trailing-debounced to one write per burst.
    expect(store.__oc_costUsd).toBeUndefined();
    const center = document.getElementById("statusCenter") as HTMLElement;
    expect(center.hidden).toBe(false);
  });

  test("cost events do not spam the transcript with per-call token lines", async () => {
    addLogRow({ type: "cost", step: 1, tokensIn: 100, tokensOut: 50, costUsd: 0.5, model: "m" }, "t0");
    await flushChat();
    expect(chatMessages.querySelectorAll(".msg-system").length).toBe(0);
  });

  test("repeated identical observations collapse to one line", async () => {
    addLogRow({ type: "state", step: 0, url: "u", elementCount: 34, newElementCount: 5, pageInfo: "Pricing" }, "t0");
    await flushChat();
    addLogRow({ type: "state", step: 1, url: "u", elementCount: 34, newElementCount: 0, pageInfo: "Pricing" }, "t1");
    await flushChat();
    expect(chatMessages.querySelectorAll(".msg-system").length).toBe(1);
    // A genuinely different observation renders again.
    addLogRow({ type: "state", step: 2, url: "u", elementCount: 41, newElementCount: 7, pageInfo: "Pricing" }, "t2");
    await flushChat();
    expect(chatMessages.querySelectorAll(".msg-system").length).toBe(2);
  });

  test("action cards use a friendly label, icon, and element target", async () => {
    addLogRow({ type: "action", step: 1, index: 1, total: 2, name: "click", description: "click element [5]" }, "t0");
    await flushChat();
    const card = chatMessages.querySelector(".activity-tool") as HTMLElement;
    expect(card).not.toBeNull();
    // Friendly label ("Click · 1/2") not the raw snake-case name.
    expect(card.textContent).toContain("Click · 1/2");
    expect(card.textContent).not.toContain("click · 1/2");
    // Element target extracted from the description.
    expect(card.textContent).toContain("element [5]");
    // Cursor/pointer glyph for click actions.
    expect(card.querySelector(".activity-icon")?.textContent).toBe("🖱️");
  });

  test("thinking card shows reasoning text as primary content and goal as a highlight", async () => {
    addLogRow({
      type: "thinking", step: 1, nextGoal: "find the login button",
      text: "looking for it", evaluation: "page loaded", memory: "pricing found",
    }, "t0");
    await flushChat();
    const card = chatMessages.querySelector(".activity-reasoning") as HTMLElement;
    expect(card.querySelector(".activity-reasoning-text")?.textContent).toBe("looking for it");
    expect(card.querySelector(".activity-next-goal")?.textContent).toContain("find the login button");
    // Secondary fields stay in the DOM (collapsed <details>), so the transcript
    // still carries the full reasoning context.
    expect(card.textContent).toContain("page loaded");
    expect(card.textContent).toContain("pricing found");
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
        getURL: (path: string) => `chrome-extension://test/${path}`,
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

  test("accepts a valid AGENT_EVENT envelope from the extension", async () => {
    const ret = gateListener!(
      { type: "AGENT_EVENT", event: { type: "info", message: "hello" }, time: "t0" },
      { id: "test" },
      () => {},
    );
    expect(ret).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(countMsgs()).toBe(1);
    expect(chatMessages.textContent).toContain("hello");
  });

  test("accepts a valid visual-inspection envelope", async () => {
    gateListener!(
      {
        type: "AGENT_EVENT",
        event: {
          type: "visual-inspection", step: 1, stage: "captured",
          screenshotChars: 20480, message: "overlay rendered",
        },
        time: "t0",
      },
      { id: "test" },
      () => {},
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(chatMessages.textContent).toContain("Vision captured");
    expect(chatMessages.textContent).toContain("overlay rendered");
    expect(chatMessages.textContent).toContain("20 KB");
  });

  test("drops a malformed visual-inspection envelope", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      gateListener!(
        {
          type: "AGENT_EVENT",
          event: { type: "visual-inspection", step: 1, stage: "skipped" },
          time: "t0",
        },
        { id: "test" },
        () => {},
      );
      expect(countMsgs()).toBe(0);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("accepts the exact MV3 background worker URL Brave supplies", async () => {
    gateListener!(
      { type: "AGENT_EVENT", event: { type: "info", message: "from worker" }, time: "t0" },
      { id: "test", url: "chrome-extension://test/background.js" },
      () => {},
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(chatMessages.textContent).toContain("from worker");
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
