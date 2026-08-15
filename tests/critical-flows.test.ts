/**
 * Critical-flow E2E at the jsdom level.
 *
 * Each critical workflow is walked end-to-end through the REAL surface
 * modules (store dispatch + DOM wiring), asserting the full state walk
 * including error and recovery paths:
 *
 *   1. Run start → progress → Stop → result (side panel).
 *   2. Provider/key/model setup → connection test → save (Options).
 *   3. Schedule create → list → delete (Options, incl. confirmation gate).
 *   4. History load → clear → export → import (Options, incl. confirmation gate).
 *
 * Module graphs are reset per test (vi.resetModules) so the reducer-store
 * singletons and DOM listeners start fresh, mirroring a new extension page.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { makeChromeStorageMock } from "./helpers/chrome-storage-mock";

interface RunHarness {
  sent: string[];
  statusResponses: unknown[];
  stopResponse: unknown;
  runResponse: unknown;
  onChangedListener: ((changes: Record<string, { newValue?: unknown }>, area: string) => void) | null;
  localStore: Map<string, unknown>;
  sessionStore: Map<string, unknown>;
}

function mountSidepanelDom(): void {
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
    <select id="modeSelect"><option value="standard">Standard</option></select>
    <button id="openOptions"></button>
    <div id="statusCenter" hidden></div>
    <div id="runSummary" hidden></div>
    <div id="runTaskLabel"></div>
    <div id="runPhaseLabel"></div>
    <div id="runErrorLive"></div>
    <div id="ocLiveStatus"></div>
    <div id="ocLiveAlert"></div>
  `;
}

function setupSidepanelChrome(): RunHarness {
  const h: RunHarness = {
    sent: [],
    statusResponses: [],
    stopResponse: { ok: true, status: "cancelling" },
    runResponse: { ok: true },
    onChangedListener: null,
    localStore: new Map<string, unknown>([["provider", "openai"]]),
    sessionStore: new Map<string, unknown>([["apiKey", "sk-test-1234567890"]]),
  };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      id: "test",
      lastError: undefined,
      onMessage: { addListener: () => {} },
      sendMessage: (msg: unknown, cb?: (res: unknown) => void) => {
        const m = msg as { type: string };
        h.sent.push(m.type);
        if (m.type === "STATUS") cb?.(h.statusResponses.shift());
        else if (m.type === "RUN") cb?.(h.runResponse);
        else if (m.type === "STOP") cb?.(h.stopResponse);
        return Promise.resolve();
      },
    },
    storage: {
      local: {
        get: (k: unknown, cb?: (res: Record<string, unknown>) => void) => {
          const keys = Array.isArray(k) ? k : [k];
          const res: Record<string, unknown> = {};
          for (const key of keys) if (h.localStore.has(key)) res[key] = h.localStore.get(key);
          cb?.(res);
          return Promise.resolve(res);
        },
        set: (items: Record<string, unknown>) => {
          Object.entries(items).forEach(([k, v]) => h.localStore.set(k, v));
          return Promise.resolve();
        },
        remove: () => Promise.resolve(),
      },
      session: {
        get: (k: unknown, cb?: (res: Record<string, unknown>) => void) => {
          const keys = Array.isArray(k) ? k : [k];
          const res: Record<string, unknown> = {};
          for (const key of keys) if (h.sessionStore.has(key)) res[key] = h.sessionStore.get(key);
          cb?.(res);
          return Promise.resolve(res);
        },
        set: (items: Record<string, unknown>) => {
          Object.entries(items).forEach(([k, v]) => h.sessionStore.set(k, v));
          return Promise.resolve();
        },
        remove: () => Promise.resolve(),
      },
      onChanged: {
        addListener: (fn: (changes: Record<string, { newValue?: unknown }>, area: string) => void) => {
          h.onChangedListener = fn;
        },
      },
    },
  } as unknown as typeof chrome;
  return h;
}

interface Snapshot {
  version: 1;
  runId: string;
  revision: number;
  dispatchRevision: number;
  task: string;
  maxSteps: number;
  mode: string;
  status: "starting" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled" | "interrupted";
  phase: string;
  step: number;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  activeOperation?: string;
  terminalReason?: string;
  terminalMessage?: string;
  resultText?: string;
}

function snapshotOf(overrides: Partial<Snapshot> & Pick<Snapshot, "status" | "phase">): Snapshot {
  return {
    version: 1,
    runId: "run-1",
    revision: 1,
    dispatchRevision: 1,
    task: "book a flight",
    maxSteps: 100,
    mode: "standard",
    step: 0,
    startedAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}


// ─── Flow 1: run start → progress → Stop → result (side panel) ─────────────

describe("Flow 1 — side panel run start → progress → Stop → result", () => {
  beforeEach(() => {
    vi.resetModules();
    mountSidepanelDom();
  });

  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  test("full state walk: starting → acting → cancelling → cancelled terminal, then a successor run starts", async () => {
    const h = setupSidepanelChrome();
    await import("../src/extension/sidepanel/controls");

    const input = document.getElementById("messageInput") as HTMLTextAreaElement;
    const sendBtn = document.getElementById("sendBtn") as HTMLButtonElement;
    const stopBtn = document.getElementById("stopBtn") as HTMLButtonElement;
    const statusLabel = document.getElementById("statusLabel") as HTMLSpanElement;
    const phaseLabel = document.getElementById("runPhaseLabel") as HTMLDivElement;
    const taskLabel = document.getElementById("runTaskLabel") as HTMLDivElement;

    // Send a task → optimistic starting, RUN issued to the background.
    input.value = "book a flight";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    sendBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.sent).toContain("RUN");
    expect(statusLabel.textContent).toBe("Thinking…");
    expect(stopBtn.disabled).toBe(false); // Stop reachable from the first moment
    expect(sendBtn.disabled).toBe(true);
    expect(taskLabel.textContent).toBe("book a flight");

    // Background confirms with the authoritative running snapshot (progress)
    // through the session-storage channel a second panel would observe.
    h.onChangedListener?.(
      {
        open_cowork_run_snapshot_v1: {
          newValue: snapshotOf({
            revision: 2,
            status: "running",
            phase: "acting",
            step: 3,
            activeOperation: "clicking submit",
          }),
        },
      },
      "session",
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(statusLabel.textContent).toBe("Acting…");
    expect(phaseLabel.textContent).toContain("acting · step 3");
    expect(stopBtn.disabled).toBe(false);


    // Stop → immediate cancelling UI, STOP issued exactly once.
    stopBtn.click();
    expect(h.sent).toContain("STOP");
    expect(statusLabel.textContent).toBe("Cancelling…");
    expect(stopBtn.disabled).toBe(true);
    expect(stopBtn.getAttribute("aria-label")).toBe("Cancellation in progress");

    // Background confirms the terminal cancelled snapshot via the storage
    // channel (the same path a second panel would observe).
    h.onChangedListener?.(
      {
        open_cowork_run_snapshot_v1: {
          newValue: snapshotOf({
            revision: 3,
            status: "cancelled",
            phase: "terminal",
            endedAt: 2000,
            terminalReason: "cancelled",
            terminalMessage: "Agent stopped by user.",
          }),
        },
      },
      "session",
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(statusLabel.textContent).toBe("Cancelled");
    expect((document.getElementById("statusDot") as HTMLSpanElement).dataset.status).toBe("cancelled");
    expect(stopBtn.disabled).toBe(true);
    // Terminal result rendered in the transcript.
    const chat = document.getElementById("chatMessages") as HTMLDivElement;
    expect(chat.textContent).toContain("Agent stopped by user.");
    // Input is usable again for a follow-up run (recovery).
    expect(input.disabled).toBe(false);
    expect((document.getElementById("runSummary") as HTMLDivElement).hidden).toBe(false);

    // Successor run after terminal (recovery) — a new RUN goes out.
    h.sent.length = 0;
    input.value = "send the report";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    sendBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.sent).toContain("RUN");
    expect(statusLabel.textContent).toBe("Thinking…");
  });

  test("RUN transport failure surfaces a typed terminal error and re-enables input (recovery)", async () => {
    const h = setupSidepanelChrome();
    await import("../src/extension/sidepanel/controls");

    const input = document.getElementById("messageInput") as HTMLTextAreaElement;
    const sendBtn = document.getElementById("sendBtn") as HTMLButtonElement;
    const statusLabel = document.getElementById("statusLabel") as HTMLSpanElement;

    input.value = "do the thing";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    h.runResponse = { ok: false, error: "Provider returned HTTP 401" };
    sendBtn.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(statusLabel.textContent).toBe("Error");
    expect((document.getElementById("chatMessages") as HTMLDivElement).textContent).toContain("Provider returned HTTP 401");
    expect(input.disabled).toBe(false);
    // Recovery: the failed run must not wedge the send path — typing again
    // re-enables Send (input was cleared by the failed send).
    input.value = "retry";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(sendBtn.disabled).toBe(false);
  });

  test("STOP transport failure keeps an actionable cancelling UI and reconciles via STATUS", async () => {
    const h = setupSidepanelChrome();
    await import("../src/extension/sidepanel/controls");

    const input = document.getElementById("messageInput") as HTMLTextAreaElement;
    const sendBtn = document.getElementById("sendBtn") as HTMLButtonElement;
    const stopBtn = document.getElementById("stopBtn") as HTMLButtonElement;
    const statusLabel = document.getElementById("statusLabel") as HTMLSpanElement;

    input.value = "task";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    h.runResponse = { ok: true, snapshot: snapshotOf({ revision: 2, status: "running", phase: "reasoning", step: 1 }) };
    sendBtn.click();
    await new Promise((r) => setTimeout(r, 0));

    // STOP fails at the transport level. Push the STATUS response the failed
    // STOP path polls immediately (STATUS is the source of truth after a
    // failed STOP transport).
    h.statusResponses.push({ running: false });
    h.stopResponse = { ok: false, error: "background went to sleep" };
    stopBtn.click();
    // Synchronously: the immediate cancelling UI is already on screen…
    expect(statusLabel.textContent).toBe("Cancelling…");
    await new Promise((r) => setTimeout(r, 0));
    // …and the failure is reported in the transcript.
    expect((document.getElementById("chatMessages") as HTMLDivElement).textContent).toContain("Stop failed");

    await new Promise((r) => setTimeout(r, 50));
    expect(statusLabel.textContent).toBe("Ready");
    expect(stopBtn.disabled).toBe(true);
  });
});

// ─── Options helpers (flows 2–4) ────────────────────────────────────────────

/**
 * Full Options DOM. Every `$()` accessor across settings-sync, provider-config-
 * ui, scheduled-tasks, history, and the modal throws on a missing id, so the
 * harness must be comprehensive (mirrors the real options.html surface).
 */
function mountOptionsDom(): void {
  document.body.innerHTML = `
    <nav class="tabs"></nav>
    <select id="provider"></select>
    <input id="apiKey">
    <input type="checkbox" id="rememberApiKey">
    <input id="model">
    <input id="baseUrl">
    <input id="resourceName">
    <span id="provider-hint"></span>
    <span id="apikey-hint"></span>
    <label id="baseurl-label"></label>
    <label id="resourcename-label"></label>
    <div id="opencode-endpoint-hint"></div>
    <input id="maxSteps">
    <input id="maxActions">
    <input id="plannerInterval">
    <input id="maxFailures">
    <input id="costCap">
    <textarea id="defaultTask"></textarea>
    <input id="screenshotQuality">
    <input id="screenshotImageTokens">
    <input id="screenshotMaxDimension">
    <input id="screenshotMaxBytes">
    <input type="checkbox" id="enableScreenshots">
    <input type="checkbox" id="enableStealth">
    <input type="checkbox" id="enableVerboseNavigatorPrompt">
    <textarea id="allowedDomains"></textarea>
    <textarea id="blockedDomains"></textarea>
    <select id="agentMode"><option value="restricted">Restricted</option><option value="standard" selected>Standard</option><option value="full_agentic">Full agentic</option></select>
    <select id="reasoningEffort"><option value="medium">medium</option></select>
    <input id="reasoningBudget">
    <select id="forceReasoning"><option value="auto">auto</option></select>
    <input id="webhookUrl">
    <input type="checkbox" id="notifyOnCompletion">
    <input type="checkbox" id="notifyOnError">
    <input type="checkbox" id="notifyOnTakeover">
    <input type="radio" name="visionMode" value="disabled" checked>
    <input type="radio" name="visionMode" value="local">
    <div id="saved"></div>
    <span id="saveSummary"></span>
    <div id="statusMessage"></div>
    <div id="errorMessage"></div>
    <button id="addSecret"></button>
    <input id="secretName">
    <input id="secretValue">
    <div id="secretsList"></div>
    <datalist id="model-suggestions"></datalist>
    <div id="model-search-results"></div>
    <button id="testConnection"></button>
    <span id="testResult"></span>
    <button id="refreshModels"></button>
    <span id="refreshModelsStatus"></span>
    <input id="scheduleTask">
    <select id="scheduleType"><option value="interval">interval</option><option value="daily">daily</option></select>
    <input id="scheduleInterval" value="60">
    <input id="scheduleTime" value="08:30">
    <select id="scheduleDay"><option value="1">Mon</option></select>
    <select id="scheduleMode"><option value="standard">standard</option></select>
    <button id="addSchedule"></button>
    <div id="scheduleList"></div>
    <button id="exportSchedules"></button>
    <button id="importSchedules"></button>
    <input id="importSchedulesFile">
    <div id="historyList"></div>
    <button id="clearHistory"></button>
    <button id="exportHistory"></button>
    <button id="importHistory"></button>
    <input id="importHistoryFile">
  `;
}

interface OptionsChromeOptions {
  /** Answers OPTIONS_PLATFORM_COMMAND { command: { kind } }. */
  platformCommand?: (kind: string, command: Record<string, unknown>) => unknown;
  /** Answers SCHEDULED_TASK_COMMAND { command: { kind } }. */
  scheduledTaskCommand?: (kind: string, command: Record<string, unknown>) => unknown;
  /** Answers HISTORY_COMMAND { command: { kind } }. */
  historyCommand?: (kind: string, command: Record<string, unknown>) => unknown;
  localStore?: Map<string, unknown>;
}

function setupOptionsChrome(opts: OptionsChromeOptions): {
  local: Map<string, unknown>;
  session: Map<string, unknown>;
  sent: Array<{ type: string; command?: { kind: string } }>;
} {
  const local = opts.localStore ?? new Map<string, unknown>();
  const session = new Map<string, unknown>([["apiKey", "sk-test-1234567890"]]);
  const sent: Array<{ type: string; command?: { kind: string } }> = [];
  const chromeMock = makeChromeStorageMock(local, session);
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      id: "test",
      lastError: undefined,
      onMessage: { addListener: () => {} },
      getManifest: () => ({ permissions: ["storage", "tabs"], host_permissions: ["<all_urls>"] }),
      sendMessage: (msg: unknown) => {
        const m = msg as { type: string; command: { kind: string } };
        sent.push({ type: m.type, command: m.command });
        if (m.type === "OPTIONS_PLATFORM_COMMAND") {
          return Promise.resolve(opts.platformCommand?.(m.command.kind, m.command) ?? { ok: false, error: "unhandled" });
        }
        if (m.type === "SCHEDULED_TASK_COMMAND") {
          return Promise.resolve(opts.scheduledTaskCommand?.(m.command.kind, m.command) ?? { ok: false, error: "unhandled" });
        }
        if (m.type === "HISTORY_COMMAND") {
          return Promise.resolve(opts.historyCommand?.(m.command.kind, m.command) ?? { ok: false, error: "unhandled" });
        }
        return Promise.resolve({ ok: false, error: `unhandled message ${m.type}` });
      },
    },
    storage: chromeMock.storage,
  } as unknown as typeof chrome;
  return { local, session, sent };
}

// ─── Flow 2: provider/key/model setup → connection test → save ─────────────

describe("Flow 2 — Options provider/key/model setup → connection test → save", () => {
  beforeEach(() => {
    vi.resetModules();
    mountOptionsDom();
  });

  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
    document.body.innerHTML = "";
  });

  test("full state walk: selection → pending test → success → save ack with confirmable summary", async () => {
    const { sent } = setupOptionsChrome({
      platformCommand: (kind) => {
        if (kind === "credential_status") {
          return { ok: true, kind: "credential_status", status: { status: "ready", reference: "cred-1" } };
        }
        if (kind === "connection_test") {
          return {
            ok: true,
            kind: "connection_test",
            result: {
              version: 1, ok: true, code: "ok", latencyMs: 42,
              provider: "openai", model: "gpt-4o",
              message: "Connected (42ms, 3 models available)",
            },
          };
        }
        return { ok: false, error: "unhandled" };
      },
    });

    await import("../src/extension/options/settings-sync");
    await import("../src/extension/options/provider-config-ui");
    const { settingsSyncStore, providerConfigStore, connectionDiagnosticsStore } =
      await import("../src/extension/options/stores");
    // Wire the real auto-save listeners (options/index.ts does this in prod)
    // so the provider <select> change funnels through the authoritative store.
    const { initAutoSave } = await import("../src/extension/options/settings-sync");
    initAutoSave();

    // Loading state settles (SETTINGS_LOAD_START → OK via the storage mock).
    await new Promise((r) => setTimeout(r, 0));
    expect(settingsSyncStore.getState().loadState).toBe("ok");

    // Provider + key + model setup through the real controls.
    const providerSel = document.getElementById("provider") as HTMLSelectElement;
    providerSel.value = "openai";
    providerSel.dispatchEvent(new Event("change", { bubbles: true }));
    (document.getElementById("model") as HTMLInputElement).value = "gpt-4o";
    (document.getElementById("apiKey") as HTMLInputElement).value = "sk-test-1234567890";
    await new Promise((r) => setTimeout(r, 0));
    expect(providerConfigStore.getState().provider).toBe("openai");
    expect(providerConfigStore.getState().generation).toBeGreaterThan(0);

    // Connection test: button disables + aria-busy while pending…
    const testBtn = document.getElementById("testConnection") as HTMLButtonElement;
    const testResult = document.getElementById("testResult") as HTMLSpanElement;
    testBtn.click();
    expect(testBtn.disabled).toBe(true);
    expect(testBtn.getAttribute("aria-busy")).toBe("true");
    expect(testResult.textContent).toBe("Testing…");
    await new Promise((r) => setTimeout(r, 0));
    // …then resolves through the store into a success render.
    expect(connectionDiagnosticsStore.getState().current.state).toBe("ok");
    expect(testResult.textContent).toContain("✓ Connected (42ms, 3 models available)");
    expect(testBtn.disabled).toBe(false);
    expect(testBtn.getAttribute("aria-busy")).toBe("false");
    expect(
      sent.some((m) => m.type === "OPTIONS_PLATFORM_COMMAND" && m.command?.kind === "connection_test"),
    ).toBe(true);

    // Save: acknowledged only after the storage write settles, with the
    // confirmable no-silent-changes summary rendered + announced. A mode
    // change made in THIS session must appear in the summary (never silent).
    const agentModeSel = document.getElementById("agentMode") as HTMLSelectElement;
    agentModeSel.value = "full_agentic";
    agentModeSel.dispatchEvent(new Event("change", { bubbles: true }));
    const { saveSettings } = await import("../src/extension/options/settings-sync");
    const ok = await saveSettings();
    expect(ok).toBe(true);
    expect(settingsSyncStore.getState().saveState).toBe("ok");
    const summary = (document.getElementById("saveSummary") as HTMLSpanElement).textContent ?? "";
    expect(summary).toContain("mode: full_agentic");
    expect(summary).toContain("cost cap: none");
    expect(summary).toContain("provider: openai (default endpoint)");
    // This is permission for model-requested one-shot frames; adaptive mode
    // remains DOM + AX-only until the model explicitly asks for pixels.
    expect(summary).toContain("screenshots: on");
    expect(summary).toContain("notify webhook: none");
    expect((document.getElementById("statusMessage") as HTMLDivElement).textContent).toContain("Settings saved");
  });

  test("a failing connection test renders the typed error, then a retry recovers", async () => {
    let failing = true;
    setupOptionsChrome({
      platformCommand: (kind) => {
        if (kind === "credential_status") {
          return { ok: true, kind: "credential_status", status: { status: "ready", reference: "cred-1" } };
        }
        if (kind === "connection_test") {
          if (failing) {
            return {
              ok: true,
              kind: "connection_test",
              result: {
                version: 1, ok: false, code: "auth_error", latencyMs: 12,
                provider: "openai", model: "gpt-4o",
                message: "Invalid API key (redacted)",
              },
            };
          }
          return {
            ok: true,
            kind: "connection_test",
            result: {
              version: 1, ok: true, code: "ok", latencyMs: 30,
              provider: "openai", model: "gpt-4o",
              message: "Connected (30ms)",
            },
          };
        }
        return { ok: false, error: "unhandled" };
      },
    });

    await import("../src/extension/options/settings-sync");
    await import("../src/extension/options/provider-config-ui");
    const { connectionDiagnosticsStore } = await import("../src/extension/options/stores");
    await new Promise((r) => setTimeout(r, 0));

    (document.getElementById("provider") as HTMLSelectElement).value = "openai";
    (document.getElementById("model") as HTMLInputElement).value = "gpt-4o";
    const testBtn = document.getElementById("testConnection") as HTMLButtonElement;
    const testResult = document.getElementById("testResult") as HTMLSpanElement;

    testBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(connectionDiagnosticsStore.getState().current.state).toBe("failed");
    expect(testResult.textContent).toContain("✗ Invalid API key");
    expect((document.getElementById("errorMessage") as HTMLDivElement).textContent).toContain("Connection test failed");

    // Recovery: fix the key, retry, and the surface flips to success.
    failing = false;
    testBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(connectionDiagnosticsStore.getState().current.state).toBe("ok");
    expect(testResult.textContent).toContain("✓ Connected (30ms)");
    expect(testBtn.disabled).toBe(false);
  });

  test("changing provider/model while a test is in flight invalidates the surface (generation guard)", async () => {
    let resolveTest!: (v: unknown) => void;
    const gate = new Promise<unknown>((r) => { resolveTest = r; });
    setupOptionsChrome({
      platformCommand: (kind) => {
        if (kind === "credential_status") {
          return { ok: true, kind: "credential_status", status: { status: "ready", reference: "cred-1" } };
        }
        if (kind === "connection_test") return gate;
        return { ok: false, error: "unhandled" };
      },
    });

    await import("../src/extension/options/settings-sync");
    await import("../src/extension/options/provider-config-ui");
    const { providerConfigStore, connectionDiagnosticsStore } = await import("../src/extension/options/stores");
    await new Promise((r) => setTimeout(r, 0));

    (document.getElementById("provider") as HTMLSelectElement).value = "openai";
    (document.getElementById("model") as HTMLInputElement).value = "gpt-4o";
    (document.getElementById("testConnection") as HTMLButtonElement).click();
    expect(connectionDiagnosticsStore.getState().current.state).toBe("pending");

    // A provider change bumps the generation while the test is in flight.
    (document.getElementById("provider") as HTMLSelectElement).value = "anthropic";
    providerConfigStore.dispatch({ type: "PROVIDER_SELECTED", provider: "anthropic" });
    expect(connectionDiagnosticsStore.getState().current.state).toBe("idle");

    // The late response carries the OLD generation and is dropped — the
    // surface must not flip to a stale success for the previous selection.
    resolveTest({
      ok: true,
      kind: "connection_test",
      result: { version: 1, ok: true, code: "ok", latencyMs: 10, provider: "openai", model: "gpt-4o", message: "Connected (10ms)" },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(connectionDiagnosticsStore.getState().current.state).toBe("idle");
    expect((document.getElementById("testResult") as HTMLSpanElement).textContent).not.toContain("Connected");
  });
});

// ─── Flow 3: schedule create → list → delete ───────────────────────────────

describe("Flow 3 — Options schedule create → list → delete", () => {
  beforeEach(() => {
    vi.resetModules();
    mountOptionsDom();
  });

  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
    document.body.innerHTML = "";
  });

  test("full state walk: empty list → save → worker-acked row → delete gate → confirmed delete → empty; cancel keeps the row", async () => {
    let tasks: unknown[] = [];
    const { sent } = setupOptionsChrome({
      scheduledTaskCommand: (kind, command) => {
        if (kind === "list") return { ok: true, tasks };
        if (kind === "save") {
          tasks = [(command as { task: unknown }).task];
          return { ok: true, tasks };
        }
        if (kind === "delete") {
          tasks = [];
          return { ok: true, tasks };
        }
        return { ok: true, tasks };
      },
    });

    const { renderSchedule } = await import("../src/extension/options/scheduled-tasks");
    const { schedulesStore } = await import("../src/extension/options/stores");
    await renderSchedule();
    const list = document.getElementById("scheduleList") as HTMLDivElement;

    // Empty state is useful and explicit.
    expect(list.textContent).toContain("No scheduled tasks");
    expect(schedulesStore.getState().listAck.state).toBe("acked");

    // Create: fill the form and add through the real button.
    (document.getElementById("scheduleTask") as HTMLInputElement).value = "weekly report";
    (document.getElementById("scheduleType") as HTMLSelectElement).value = "daily";
    (document.getElementById("scheduleTime") as HTMLInputElement).value = "08:30";
    (document.getElementById("addSchedule") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(
      sent.some((m) => m.type === "SCHEDULED_TASK_COMMAND" && m.command?.kind === "save"),
    ).toBe(true);
    expect(list.querySelector(".schedule-item")).not.toBeNull();
    expect(list.textContent).toContain("weekly report");
    expect(schedulesStore.getState().mutationAck.state).toBe("acked");

    // Delete: the destructive-action gate blocks until explicit confirmation.
    const delBtn = list.querySelector<HTMLButtonElement>("button.schedule-delete");
    expect(delBtn).not.toBeNull();
    delBtn?.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(
      sent.some((m) => m.type === "SCHEDULED_TASK_COMMAND" && m.command?.kind === "delete"),
    ).toBe(false); // NOT sent before confirmation
    const overlay = document.querySelector<HTMLDivElement>(".modal-overlay");
    expect(overlay).not.toBeNull();
    // Cancel leaves the task list untouched.
    const footer = overlay?.querySelectorAll<HTMLButtonElement>(".modal-footer button");
    footer?.[0]?.click(); // Cancel
    await new Promise((r) => setTimeout(r, 0));
    expect(schedulesStore.getState().tasks).toHaveLength(1);
    expect(document.querySelector(".modal-overlay")).toBeNull();

    // Confirm the delete: the danger button has an anti-misclick delay.
    delBtn?.click();
    await new Promise((r) => setTimeout(r, 250));
    const overlay2 = document.querySelector<HTMLDivElement>(".modal-overlay");
    const footer2 = overlay2?.querySelectorAll<HTMLButtonElement>(".modal-footer button");
    footer2?.[footer2.length - 1]?.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(
      sent.some((m) => m.type === "SCHEDULED_TASK_COMMAND" && m.command?.kind === "delete"),
    ).toBe(true);
    expect(list.textContent).toContain("No scheduled tasks");
    expect(schedulesStore.getState().tasks).toHaveLength(0);
    // Focus moved to the add-prompt (keyboard recovery contract).
    expect(document.activeElement?.id).toBe("scheduleTask");
  });

  test("a failed delete surfaces an explicit error and re-lists the worker state (no silent loss)", async () => {
    const tasks: unknown[] = [
      { id: "t1", task: "keep me", schedule: { type: "daily", hour: 9, minute: 0 }, enabled: true, createdAt: 100, revision: 1 },
    ];
    setupOptionsChrome({
      scheduledTaskCommand: (kind) => {
        if (kind === "list") return { ok: true, tasks };
        if (kind === "delete") return { ok: false, code: "SCHEDULED_TASK_REVISION_CONFLICT", error: "changed in another window" };
        return { ok: true, tasks };
      },
    });

    const { renderSchedule } = await import("../src/extension/options/scheduled-tasks");
    const { schedulesStore } = await import("../src/extension/options/stores");
    await renderSchedule();
    const list = document.getElementById("scheduleList") as HTMLDivElement;
    expect(list.textContent).toContain("keep me");

    const delBtn = list.querySelector<HTMLButtonElement>("button.schedule-delete");
    delBtn?.click();
    await new Promise((r) => setTimeout(r, 250));
    const overlay = document.querySelector<HTMLDivElement>(".modal-overlay");
    const footer = overlay?.querySelectorAll<HTMLButtonElement>(".modal-footer button");
    footer?.[footer.length - 1]?.click();
    await new Promise((r) => setTimeout(r, 0));

    // Failed mutation: ack failed, the previously-acknowledged list is NOT lost.
    expect(schedulesStore.getState().mutationAck.state).toBe("failed");
    expect(schedulesStore.getState().tasks).toHaveLength(1);
    // The error alert surfaced…
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector(".modal-overlay")).not.toBeNull();
    // …close it, then the re-list recovery keeps the row visible.
    const alertFooter = document.querySelectorAll<HTMLButtonElement>(".modal-footer button");
    alertFooter[alertFooter.length - 1]?.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(list.textContent).toContain("keep me");
  });
});

// ─── Flow 4: history load → clear → export → import ────────────────────────

describe("Flow 4 — Options history load → clear → export → import", () => {
  beforeEach(() => {
    vi.resetModules();
    mountOptionsDom();
  });

  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
    document.body.innerHTML = "";
  });

  test("full state walk: load renders entries → clear gate → confirmed clear → empty; cancel keeps the list", async () => {
    let runs: unknown[] = [
      { id: "r1", task: "demo run", startedAt: 1, endedAt: 2, stepCount: 3, totalCostUsd: 0.1, result: { success: true, text: "done" } },
    ];
    setupOptionsChrome({
      historyCommand: (kind) => {
        if (kind === "list") return { ok: true, runs, revision: 1 };
        if (kind === "clear") { runs = []; return { ok: true, runs: [], revision: 2 }; }
        return { ok: true, runs, revision: 1 };
      },
    });

    const { renderHistory } = await import("../src/extension/options/history");
    const { historyStore } = await import("../src/extension/options/stores");
    await renderHistory();
    const list = document.getElementById("historyList") as HTMLDivElement;

    // Loaded entries render with an explicit load ack.
    expect(historyStore.getState().loadState).toBe("ok");
    expect(list.querySelector(".history-item")).not.toBeNull();
    expect(list.textContent).toContain("demo run");

    // Clear history is gated behind the danger confirmation.
    const clearBtn = document.getElementById("clearHistory") as HTMLButtonElement;
    clearBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(historyStore.getState().mutationState).toBe("idle"); // nothing dispatched yet
    const overlay = document.querySelector<HTMLDivElement>(".modal-overlay");
    expect(overlay).not.toBeNull();
    // Cancel leaves the history intact.
    const footer = overlay?.querySelectorAll<HTMLButtonElement>(".modal-footer button");
    footer?.[0]?.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(historyStore.getState().entries).toHaveLength(1);

    // Confirm: danger delay, then the clear command fires and the list empties.
    clearBtn.click();
    await new Promise((r) => setTimeout(r, 250));
    const overlay2 = document.querySelector<HTMLDivElement>(".modal-overlay");
    const footer2 = overlay2?.querySelectorAll<HTMLButtonElement>(".modal-footer button");
    footer2?.[footer2.length - 1]?.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(historyStore.getState().mutationState).toBe("ok");
    expect(historyStore.getState().entries).toHaveLength(0);
    expect(list.textContent).toContain("No runs yet");
  });

  test("export acknowledges through the store and produces a redacted blob", async () => {
    const runs = [
      { id: "r1", task: "demo", startedAt: 1, endedAt: 2, stepCount: 1, totalCostUsd: 0.1, transcript: { echoed: "gsk_live_abc123def456ghi789jkl012" } },
    ];
    setupOptionsChrome({
      historyCommand: (kind) => {
        if (kind === "export") return { ok: true, runs };
        return { ok: false, error: "unhandled" };
      },
    });

    await import("../src/extension/options/history");
    const { historyStore } = await import("../src/extension/options/stores");

    const blobs: Blob[] = [];
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    URL.createObjectURL = ((b: Blob) => { blobs.push(b); return "blob:history-export"; }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
    try {
      (document.getElementById("exportHistory") as HTMLButtonElement).click();
      const deadline = Date.now() + 2000;
      while (blobs.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
    } finally {
      anchorClick.mockRestore();
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
    expect(blobs.length).toBe(1);
    expect(historyStore.getState().lastMutation?.kind).toBe("export");
    expect(historyStore.getState().lastMutation?.ok).toBe(true);
    const text = await blobs[0].text();
    expect(text).not.toContain("gsk_live_abc123def456ghi789jkl012");
    expect(text).toContain("gsk_[REDACTED]");
  });

  test("import validates, acks with the merged summary, and renders the updated list", async () => {
    let runs: unknown[] = [];
    setupOptionsChrome({
      historyCommand: (kind, command) => {
        if (kind === "list") return { ok: true, runs, revision: 0 };
        if (kind === "import") {
          runs = (command as { entries: unknown[] }).entries ?? [];
          return { ok: true, runs, revision: 1, imported: 1, skippedInvalid: 0, droppedForCap: 0, existingDropped: 0 };
        }
        return { ok: false, error: "unhandled" };
      },
    });

    const { renderHistory } = await import("../src/extension/options/history");
    const { historyStore } = await import("../src/extension/options/stores");
    await renderHistory();
    expect(historyStore.getState().loadState).toBe("ok");

    const file = new File(
      [JSON.stringify([{ id: "r1", task: "imported run", startedAt: 1, endedAt: 2, stepCount: 1, totalCostUsd: 0.01 }])],
      "history.json",
      { type: "application/json" },
    );
    const input = document.getElementById("importHistoryFile") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));

    const deadline = Date.now() + 2000;
    while (historyStore.getState().mutationState !== "ok" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(historyStore.getState().mutationState).toBe("ok");
    expect(historyStore.getState().lastMutation?.kind).toBe("import");
    expect(historyStore.getState().lastMutation?.summary).toContain("Imported 1 run(s)");
    expect((document.getElementById("historyList") as HTMLDivElement).textContent).toContain("imported run");
  });
});
