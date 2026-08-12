/**
 * Phase 12 — keyboard interaction (jsdom level).
 *
 * Critical flows must work by keyboard with focus management:
 * - Stop (side panel): the button is keyboard-reachable exactly while a run
 *   is active, exposes a truthful aria-label, and keyboard activation sends
 *   STOP exactly once (no interference from the document "/" shortcut).
 * - Provider selection (Options): the `<select>` is natively keyboard-
 *   navigable; a keyboard-driven change funnels through the provider-config
 *   store (capabilities refresh + stale model cleared + diagnostics
 *   invalidation).
 * - Model search (Options): ArrowDown/Enter commit a highlighted result and
 *   dispatch MODEL_SELECTED (keyboard path through the same handler as click).
 * - Schedule delete (Options): keyboard activation issues the typed command
 *   and focus moves to the add-prompt so a keyboard user is not stranded.
 *
 * jsdom does not synthesize button activation for Enter/Space; tests model
 * the browser's native activation as keydown + click() and assert the a11y
 * contract (enabled/disabled, aria labels, focus) around it.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { makeChromeStorageMock } from "./helpers/chrome-storage-mock";

// ─── Side-panel Stop harness ────────────────────────────────────────────────

type SendCb = (res: unknown) => void;

interface StopHarness {
  stopResponses: unknown[];
  statusResponses: unknown[];
  sent: string[];
}

function setupStopHarness(): StopHarness {
  const h: StopHarness = { stopResponses: [], statusResponses: [], sent: [] };
  const chromeStub = {
    runtime: {
      lastError: undefined,
      id: "test",
      onMessage: { addListener: () => {} },
      sendMessage: (msg: unknown, cb?: SendCb) => {
        const m = msg as { type: string };
        h.sent.push(m.type);
        if (m.type === "STOP") cb?.(h.stopResponses.shift() ?? { ok: true, status: "idle" });
        else if (m.type === "STATUS") cb?.(h.statusResponses.shift() ?? { running: false });
        return Promise.resolve();
      },
    },
    storage: {
      local: { get: (_k: unknown, cb: (r: Record<string, unknown>) => void) => cb({}) },
      session: { get: (_k: unknown, cb: (r: Record<string, unknown>) => void) => cb({}) },
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = chromeStub;
  document.body.innerHTML = `
    <div id="chatMessages"><div class="empty-state"></div></div>
    <textarea id="messageInput"></textarea>
    <button id="sendBtn" disabled></button>
    <button id="stopBtn" disabled></button>
    <span id="costLabel">$0.0000</span>
    <span id="tokenLabel">0 tokens</span>
    <span id="statusDot" data-status="idle"></span>
    <span id="statusLabel">idle</span>
    <div id="takeoverBanner" hidden></div>
    <div id="takeoverReason"></div>
    <button id="resumeBtn"></button>
    <select id="modeSelect"></select>
    <button id="openOptions"></button>
    <div id="statusCenter"></div>
  `;
  return h;
}

// ─── Options provider/model harness ─────────────────────────────────────────

function setupOptionsDom(): {
  local: Map<string, unknown>;
  session: Map<string, unknown>;
} {
  const local = new Map<string, unknown>();
  const session = new Map<string, unknown>();
  (globalThis as unknown as { chrome: unknown }).chrome = makeChromeStorageMock(local, session);
  document.body.innerHTML = `
    <select id="provider">
      <option value="openai">OpenAI</option>
      <option value="anthropic">Anthropic</option>
      <option value="ollama">Ollama (local)</option>
    </select>
    <button id="testConnection"></button>
    <span id="testResult"></span>
    <input id="model">
    <div id="model-search-results"></div>
    <span id="provider-hint"></span>
    <input id="apiKey">
    <input type="checkbox" id="rememberApiKey" />
    <span id="apikey-hint"></span>
    <label id="baseurl-label"></label>
    <input id="baseUrl">
    <input id="resourceName">
    <label id="resourcename-label"></label>
    <div id="opencode-endpoint-hint" class="is-hidden"></div>
    <input id="maxSteps">
    <input id="maxActions">
    <input id="plannerInterval">
    <input id="maxFailures">
    <input id="costCap">
    <textarea id="defaultTask"></textarea>
    <input id="screenshotQuality">
    <input id="enableScreenshots">
    <input type="checkbox" id="enableStealth" />
    <textarea id="allowedDomains"></textarea>
    <textarea id="blockedDomains"></textarea>
    <input id="notifyOnCompletion">
    <input id="notifyOnError">
    <input id="notifyOnTakeover">
    <input id="webhookUrl">
    <div id="saved"></div>
    <button id="addSecret"></button>
    <input id="secretName">
    <input id="secretValue">
    <div id="secretsList"></div>
    <select id="reasoningEffort">
      <option value="low">low</option>
      <option value="medium" selected>medium</option>
      <option value="high">high</option>
    </select>
    <input id="reasoningBudget">
    <select id="forceReasoning">
      <option value="auto" selected>auto</option>
      <option value="on">on</option>
      <option value="off">off</option>
    </select>
    <button id="refreshModels"></button>
    <span id="refreshModelsStatus"></span>
    <div id="scheduleList"></div>
    <input id="scheduleTask">
    <button id="addSchedule"></button>
    <select id="scheduleType"><option value="daily" selected>daily</option></select>
    <input id="scheduleInterval">
    <input id="scheduleTime">
    <select id="scheduleDay"><option value="0">Sun</option></select>
    <select id="scheduleMode"><option value="standard" selected>standard</option></select>
  `;
  return { local, session };
}

describe("Phase 12 keyboard — Stop (side panel)", () => {
  let h: StopHarness;

  beforeEach(() => {
    vi.resetModules();
    h = setupStopHarness();
  });

  test("Stop is keyboard-reachable exactly while a run is active, with a truthful aria-label", async () => {
    await import("../src/extension/sidepanel/controls");
    const stopBtn = document.getElementById("stopBtn") as HTMLButtonElement;
    const runStore = await import("../src/extension/sidepanel/run-store");
    // Active run → Stop enabled and labelled for a screen reader.
    runStore.hydrateRunSnapshot({
      version: 1, runId: "r1", revision: 1, dispatchRevision: 1, task: "t",
      maxSteps: 5, mode: "standard", status: "running", phase: "acting", step: 0,
      startedAt: 1, updatedAt: 2,
    });
    expect(stopBtn.disabled).toBe(false);
    expect(stopBtn.getAttribute("aria-label")).toBe("Stop agent");
    // Terminal → Stop disabled (no dead-end focus target).
    runStore.hydrateRunSnapshot({
      version: 1, runId: "r1", revision: 2, dispatchRevision: 1, task: "t",
      maxSteps: 5, mode: "standard", status: "succeeded", phase: "terminal", step: 1,
      startedAt: 1, updatedAt: 3, endedAt: 4, terminalMessage: "done", resultText: "done",
    });
    expect(stopBtn.disabled).toBe(true);
  });

  test("keyboard activation of Stop sends STOP exactly once (no '/' shortcut interference)", async () => {
    await import("../src/extension/sidepanel/controls");
    const stopBtn = document.getElementById("stopBtn") as HTMLButtonElement;
    const runStore = await import("../src/extension/sidepanel/run-store");
    runStore.hydrateRunSnapshot({
      version: 1, runId: "r1", revision: 1, dispatchRevision: 1, task: "t",
      maxSteps: 5, mode: "standard", status: "running", phase: "acting", step: 0,
      startedAt: 1, updatedAt: 2,
    });
    h.stopResponses = [{ ok: true, status: "cancelling" }];
    // jsdom does not synthesize Enter→click; model the browser's native
    // activation: keydown must not be swallowed by any handler, then the
    // native click fires.
    const keydown = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
    stopBtn.dispatchEvent(keydown);
    stopBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.sent.filter((t) => t === "STOP")).toHaveLength(1);
  });
});

describe("Phase 12 keyboard — provider selection + model search (Options)", () => {
  let stores: ReturnType<typeof setupOptionsDom>;

  beforeEach(() => {
    vi.resetModules();
    stores = setupOptionsDom();
    // The credential vault reads IndexedDB only on demand; keep the global
    // available for the import chain (mirrors settings-sync.test.ts).
    (globalThis as unknown as { indexedDB: unknown }).indexedDB = new IDBFactory();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("a keyboard-driven provider change dispatches through the store: capabilities refresh, stale model cleared, diagnostics invalidated", async () => {
    // Simulate the page's storage hydration first (what settings-sync does at
    // import): the provider select already carries the saved provider.
    const providerSel = document.getElementById("provider") as HTMLSelectElement;
    providerSel.value = "openai";
    stores.local.set("provider", "openai");
    stores.local.set("model", "gpt-5.5");

    const { initAutoSave } = await import("../src/extension/options/settings-sync-utils");
    const { providerConfigStore, connectionDiagnosticsStore } = await import(
      "../src/extension/options/stores"
    );

    // Keyboard-driven selection: the user presses keys in the native select,
    // which lands as a `change` event (same event a mouse click fires).
    providerSel.value = "anthropic";
    const saveSpy = vi.fn(() => Promise.resolve(true));
    initAutoSave(saveSpy);
    providerSel.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));

    const state = providerConfigStore.getState();
    expect(state.provider).toBe("anthropic");
    expect(state.model).toBe(""); // stale openai model cleared by the reducer
    expect(state.capabilities.needsKey).toBe(true);
    expect(state.capabilities.defaultModel).toBeTruthy();
    // Diagnostics invalidated: a new test generation is in force.
    expect(connectionDiagnosticsStore.getState().current.generation).toBeGreaterThan(0);
    expect(saveSpy).toHaveBeenCalled();
  });

  test("model search commit via keyboard (ArrowDown + Enter) dispatches MODEL_SELECTED", async () => {
    const providerSel = document.getElementById("provider") as HTMLSelectElement;
    providerSel.value = "openai";
    stores.local.set("provider", "openai");

    await import("../src/extension/options/provider-config-ui");
    const { providerConfigStore } = await import("../src/extension/options/stores");

    const modelInput = document.getElementById("model") as HTMLInputElement;
    const resultsDiv = document.getElementById("model-search-results") as HTMLDivElement;
    modelInput.value = "gpt";
    modelInput.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 350)); // search debounce

    const items = resultsDiv.querySelectorAll<HTMLDivElement>(".model-search-result-item");
    expect(items.length).toBeGreaterThan(0);

    // Keyboard path: ArrowDown highlights the first option, Enter commits it
    // (the handler calls the same click() path a mouse click uses).
    modelInput.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    modelInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    // The commit set the input to the highlighted model's id, dispatched
    // MODEL_SELECTED into the authoritative store, and closed the dropdown.
    const committed = modelInput.value;
    expect(committed.length).toBeGreaterThan(0);
    expect(providerConfigStore.getState().model).toBe(committed);
    expect(providerConfigStore.getState().generation).toBeGreaterThan(0);
    expect(resultsDiv.classList.contains("is-hidden")).toBe(true);
  });
});

describe("Phase 12 keyboard — schedule create/delete (Options)", () => {
  let h: { sent: Array<{ type: string; command?: { kind: string } }> };

  beforeEach(() => {
    vi.resetModules();
    setupOptionsDom();
    h = { sent: [] };
    const taskList = [
      {
        id: "t1", task: "daily summary", schedule: { type: "daily", hour: 9, minute: 0 },
        enabled: true, createdAt: 100, revision: 1,
      },
    ];
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: {
        id: "test",
        lastError: undefined,
        onMessage: { addListener: () => {} },
        sendMessage: (msg: unknown) => {
          const m = msg as { type: string; command: { kind: string } };
          h.sent.push({ type: m.type, command: m.command });
          if (m.command?.kind === "list") {
            return Promise.resolve({ ok: true, tasks: taskList });
          }
          if (m.command?.kind === "delete") {
            return Promise.resolve({ ok: true, tasks: [] });
          }
          return Promise.resolve({ ok: true, tasks: taskList });
        },
      },
      storage: {
        local: {
          // provider-config-ui reads storage promise-style at import; the
          // command mock below answers SCHEDULED_TASK_COMMAND over runtime.
          get: (k: unknown, cb?: (r: Record<string, unknown>) => void) => {
            const res: Record<string, unknown> = {};
            if (cb) cb(res);
            else return Promise.resolve(res);
          },
        },
      },
    };
  });

  test("delete buttons are real focusable controls and keyboard activation issues the typed command only after the destructive-action confirmation, with focus moved to the add-prompt", async () => {
    const { renderSchedule } = await import("../src/extension/options/scheduled-tasks");
    await renderSchedule();
    const list = document.getElementById("scheduleList") as HTMLDivElement;
    const delBtn = list.querySelector<HTMLButtonElement>("button.schedule-delete");
    expect(delBtn).not.toBeNull();
    expect(delBtn?.disabled).toBe(false);
    expect(delBtn?.tagName).toBe("BUTTON"); // natively keyboard-activatable

    // Model the browser's native keyboard activation (jsdom lacks it).
    delBtn?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    delBtn?.click();
    await new Promise((r) => setTimeout(r, 0));

    // Phase 14 destructive-action gate: the delete must NOT fire until the
    // user explicitly confirms in the danger modal.
    let deleteSent = h.sent.find(
      (m) => m.type === "SCHEDULED_TASK_COMMAND" && m.command?.kind === "delete",
    );
    expect(deleteSent).toBeUndefined();
    const overlay = document.querySelector<HTMLDivElement>(".modal-overlay");
    expect(overlay).not.toBeNull();

    // Danger confirms carry an anti-misclick delay; wait it out, then confirm.
    await new Promise((r) => setTimeout(r, 250));
    const footer = overlay?.querySelectorAll<HTMLButtonElement>(".modal-footer button");
    expect(footer?.length).toBe(2); // Cancel + Delete
    footer?.[footer.length - 1]?.click();
    await new Promise((r) => setTimeout(r, 0));

    deleteSent = h.sent.find(
      (m) => m.type === "SCHEDULED_TASK_COMMAND" && m.command?.kind === "delete",
    );
    expect(deleteSent).toBeDefined();

    // The worker-acknowledged list rendered (now empty)…
    expect(list.querySelector(".empty-hint")?.textContent).toContain("No scheduled tasks");
    // …and focus moved to the add-prompt so a keyboard user is not stranded.
    expect(document.activeElement?.id).toBe("scheduleTask");
  });

  test("create flow is keyboard-reachable: Add is a focusable button that persists via the typed command", async () => {
    const { renderSchedule } = await import("../src/extension/options/scheduled-tasks");
    await renderSchedule();
    const addBtn = document.getElementById("addSchedule") as HTMLButtonElement;
    expect(addBtn.disabled).toBe(false);

    (document.getElementById("scheduleTask") as HTMLInputElement).value = "weekly report";
    (document.getElementById("scheduleType") as HTMLSelectElement).value = "daily";
    (document.getElementById("scheduleTime") as HTMLInputElement).value = "08:30";
    addBtn.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    addBtn.click();
    await new Promise((r) => setTimeout(r, 0));

    const saveSent = h.sent.find(
      (m) => m.type === "SCHEDULED_TASK_COMMAND" && m.command?.kind === "save",
    );
    expect(saveSent).toBeDefined();
  });
});



