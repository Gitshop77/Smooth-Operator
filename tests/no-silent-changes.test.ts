/**
 * No silent changes.
 *
 * Destination (provider/baseUrl/webhook), permission (screenshots/stealth),
 * cost (cost cap), mode (agent mode), and retention/delivery (webhook) changes
 * must never happen silently: every settings write renders + announces a
 * confirmable summary; every side-panel mode change is announced; and mode is
 * never silently altered by run lifecycle transitions.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { makeChromeStorageMock } from "./helpers/chrome-storage-mock";
import { composeSettingsSaveSummary } from "../src/extension/options/settings-sync-utils";

describe("composeSettingsSaveSummary covers the sensitive categories", () => {
  test("includes mode, cost cap, destination, permissions, vision, webhook, and domain scope", () => {
    const summary = composeSettingsSaveSummary({
      agentMode: "full_agentic",
      costCap: 0.5,
      provider: "openai",
      baseUrl: "https://gateway.example.com/v1",
      enableScreenshots: false,
      stealthEnabled: true,
      visionMode: "local",
      webhookUrl: "https://hooks.example.com/abc",
      allowedDomains: ["example.com", "docs.example.com"],
    });
    expect(summary).toContain("mode: full_agentic");
    expect(summary).toContain("cost cap: $0.50");
    expect(summary).toContain("provider: openai (https://gateway.example.com/v1)");
    expect(summary).toContain("screenshots: off");
    expect(summary).toContain("stealth: on");
    expect(summary).toContain("vision: local");
    expect(summary).toContain("notify webhook: https://hooks.example.com/abc");
    expect(summary).toContain("allowed domains: 2");
  });

  test("a zero cost cap and empty webhook are stated explicitly (never omitted silently)", () => {
    const summary = composeSettingsSaveSummary({
      agentMode: "standard",
      costCap: 0,
      provider: "anthropic",
      enableScreenshots: true,
      visionMode: "disabled",
      webhookUrl: "",
    });
    expect(summary).toContain("cost cap: none");
    expect(summary).toContain("notify webhook: none");
    // Default endpoint is stated when no custom baseUrl is persisted.
    expect(summary).toContain("provider: anthropic (default endpoint)");
  });

  test("a destination change is never silent: provider + baseUrl are always stated", () => {
    const before = composeSettingsSaveSummary({ provider: "openai", baseUrl: "" });
    const after = composeSettingsSaveSummary({ provider: "ollama", baseUrl: "http://localhost:11434" });
    expect(before).toContain("provider: openai (default endpoint)");
    expect(after).toContain("provider: ollama (http://localhost:11434)");
    expect(before).not.toBe(after);
  });
});


function mountOptionsDom(): void {
  document.body.innerHTML = `
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
    <select id="agentMode"><option value="standard" selected>Standard</option><option value="full_agentic">Full agentic</option></select>
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
  `;
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
    <select id="modeSelect">
      <option value="restricted">Restricted</option>
      <option value="standard" selected>Standard</option>
      <option value="full_agentic">Full agentic</option>
    </select>
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

function setupOptionsChrome(): { local: Map<string, unknown> } {
  const local = new Map<string, unknown>();
  const session = new Map<string, unknown>([["apiKey", "sk-test-1234567890"]]);
  const mock = makeChromeStorageMock(local, session);
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      id: "test",
      lastError: undefined,
      onMessage: { addListener: () => {} },
      getManifest: () => ({ permissions: ["dns"], host_permissions: [] }),
      sendMessage: () => Promise.resolve({ ok: false, error: "unhandled" }),
    },
    // chrome.dns.resolve lets the webhook's SSRF guard pass (as it would in a
    // Dev-channel build that declares the permission).
    dns: {
      resolve: (_host: string, cb?: (r: { address?: string; addresses?: string[]; resultCode?: number }) => void) => {
        cb?.({ address: "93.184.216.34", addresses: ["93.184.216.34"], resultCode: 0 });
        return Promise.resolve({ address: "93.184.216.34", addresses: ["93.184.216.34"], resultCode: 0 });
      },
    },
    storage: mock.storage,
  } as unknown as typeof chrome;
  return { local };
}

function setupSidepanelChrome(): { local: Map<string, unknown> } {
  const local = new Map<string, unknown>([["provider", "openai"], ["agentMode", "standard"]]);
  const session = new Map<string, unknown>([["apiKey", "sk-test-1234567890"]]);
  const mock = makeChromeStorageMock(local, session);
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      id: "test",
      lastError: undefined,
      onMessage: { addListener: () => {} },
      sendMessage: (msg: unknown, cb?: (res: unknown) => void) => {
        const m = msg as { type: string };
        if (m.type === "STATUS") cb?.({ running: false });
        else if (m.type === "RUN") cb?.({ ok: true });
        else if (m.type === "STOP") cb?.({ ok: true, status: "idle" });
        return Promise.resolve();
      },
    },
    storage: mock.storage,
  } as unknown as typeof chrome;
  return { local };
}

describe("No silent settings writes (Options)", () => {
  beforeEach(() => {
    vi.resetModules();
    mountOptionsDom();
  });

  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
    document.body.innerHTML = "";
  });

  test("a successful save renders the confirmable summary and announces it politely", async () => {
    setupOptionsChrome();
    await import("../src/extension/options/settings-sync");
    const { settingsSyncStore } = await import("../src/extension/options/stores");
    await new Promise((r) => setTimeout(r, 0));

    // Sensitive fields in the form.
    (document.getElementById("costCap") as HTMLInputElement).value = "1.25";
    (document.getElementById("webhookUrl") as HTMLInputElement).value = "https://hooks.example.com/wh";
    const agentMode = document.getElementById("agentMode") as HTMLSelectElement;
    agentMode.value = "full_agentic";
    agentMode.dispatchEvent(new Event("change", { bubbles: true }));

    const { saveSettings } = await import("../src/extension/options/settings-sync");
    const ok = await saveSettings();
    expect(ok).toBe(true);
    expect(settingsSyncStore.getState().saveState).toBe("ok");
    const summary = (document.getElementById("saveSummary") as HTMLSpanElement).textContent ?? "";
    expect(summary).toContain("mode: full_agentic");
    expect(summary).toContain("cost cap: $1.25");
    expect(summary).toContain("notify webhook: https://hooks.example.com/wh");
    expect((document.getElementById("statusMessage") as HTMLDivElement).textContent).toContain("Settings saved — ");
  });



  test("a storage write failure never reports success and never renders a confirmable summary", async () => {
    const local = new Map<string, unknown>();
    const session = new Map<string, unknown>([["apiKey", "sk-test-1234567890"]]);
    const mock = makeChromeStorageMock(local, session);
    const failingSet = {
      ...mock.storage.local,
      set: (_items: Record<string, unknown>, cb?: () => void) => {
        (globalThis as unknown as { chrome: { runtime: { lastError?: { message: string } } } }).chrome.runtime.lastError = {
          message: "QUOTA_BYTES exceeded",
        };
        cb?.();
        return Promise.resolve();
      },
    };
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: {
        id: "test",
        lastError: undefined,
        onMessage: { addListener: () => {} },
        getManifest: () => ({ permissions: [], host_permissions: [] }),
        sendMessage: () => Promise.resolve({ ok: false, error: "unhandled" }),
      },
      storage: { ...mock.storage, local: failingSet },
    } as unknown as typeof chrome;

    await import("../src/extension/options/settings-sync");
    const { settingsSyncStore } = await import("../src/extension/options/stores");
    await new Promise((r) => setTimeout(r, 0));

    const { saveSettings } = await import("../src/extension/options/settings-sync");
    const ok = await saveSettings();
    expect(ok).toBe(false); // never reports success
    expect(settingsSyncStore.getState().saveState).toBe("failed");
    expect(settingsSyncStore.getState().lastError).toContain("QUOTA_BYTES exceeded");
    // No success summary is rendered or announced — the failure is assertive.
    expect((document.getElementById("saveSummary") as HTMLSpanElement).textContent).toBe("");
    expect((document.getElementById("errorMessage") as HTMLDivElement).textContent).toContain("Failed to save settings");
  });
});


describe("No silent mode changes (side panel)", () => {
  beforeEach(() => {
    vi.resetModules();
    mountSidepanelDom();
  });

  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
    document.body.innerHTML = "";
  });

  test("a user mode change is announced with the exact label + consequence and persisted", async () => {
    const { local } = setupSidepanelChrome();
    await import("../src/extension/sidepanel/controls");
    await new Promise((r) => setTimeout(r, 0));

    const modeSelect = document.getElementById("modeSelect") as HTMLSelectElement;
    modeSelect.value = "full_agentic";
    modeSelect.dispatchEvent(new Event("change", { bubbles: true }));

    // Polite region announces the change (never silent)…
    expect((document.getElementById("ocLiveStatus") as HTMLDivElement).textContent).toContain("Agent mode set to Full agentic");
    expect((document.getElementById("ocLiveStatus") as HTMLDivElement).textContent).toContain("irreversible actions");
    // …and the change persists to storage.
    expect(local.get("agentMode")).toBe("full_agentic");
  });

  test("run lifecycle transitions never silently change the mode", async () => {
    setupSidepanelChrome();
    await import("../src/extension/sidepanel/controls");
    const { beginLocalRun, hydrateRunSnapshot, failLocalRun, requestLocalCancellation } =
      await import("../src/extension/sidepanel/run-store");
    await new Promise((r) => setTimeout(r, 0));

    const modeSelect = document.getElementById("modeSelect") as HTMLSelectElement;
    expect(modeSelect.value).toBe("standard");

    // Walk the whole lifecycle: start → running → stop → terminal.
    beginLocalRun("task");
    hydrateRunSnapshot({
      version: 1, runId: "r", revision: 1, dispatchRevision: 1, task: "task", maxSteps: 100,
      mode: "standard", status: "running", phase: "acting", step: 2, startedAt: 1, updatedAt: 2,
    });
    requestLocalCancellation();
    hydrateRunSnapshot({
      version: 1, runId: "r", revision: 2, dispatchRevision: 1, task: "task", maxSteps: 100,
      mode: "standard", status: "cancelled", phase: "terminal", endedAt: 3,
      terminalReason: "cancelled", terminalMessage: "stopped", startedAt: 1, updatedAt: 3,
    });
    failLocalRun("boom");

    expect(modeSelect.value).toBe("standard");
    // The status bar announced lifecycle transitions, not a mode change.
    expect((document.getElementById("ocLiveStatus") as HTMLDivElement).textContent).not.toContain("Agent mode set to");
  });
});
