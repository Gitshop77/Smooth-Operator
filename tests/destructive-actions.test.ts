/**
 * Destructive-action safety.
 *
 * Every destructive operation (delete scheduled task, clear run history,
 * delete secret) must go through the danger-styled confirmation modal with an
 * anti-misclick delay and an EXPLICIT user acknowledgement. Cancelling never
 * mutates; confirming sends the typed command exactly once. Sensitive values
 * stay masked while visible.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { makeChromeStorageMock } from "./helpers/chrome-storage-mock";

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
    <input type="checkbox" id="enableScreenshots">
    <input type="checkbox" id="enableStealth">
    <textarea id="allowedDomains"></textarea>
    <textarea id="blockedDomains"></textarea>
    <select id="agentMode"><option value="standard">Standard</option></select>
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
    <div id="historyList"></div>
    <button id="clearHistory"></button>
    <button id="exportHistory"></button>
    <button id="importHistory"></button>
    <input id="importHistoryFile">
    <div id="toolsList"></div>
    <input id="toolName">
    <textarea id="toolDescription"></textarea>
    <textarea id="toolCode"></textarea>
    <button id="addTool"></button>
    <div id="toolPermissions"></div>
  `;
}

interface Harness {
  sent: Array<{ type: string; command?: { kind: string } }>;
  session: Map<string, unknown>;
  local: Map<string, unknown>;
}

function setupChrome(opts: {
  scheduledTaskCommand?: (kind: string, command: Record<string, unknown>) => unknown;
  historyCommand?: (kind: string, command: Record<string, unknown>) => unknown;
}): Harness {
  const local = new Map<string, unknown>();
  const session = new Map<string, unknown>([
    ["apiKey", "sk-test-1234567890"],
    ["open_cowork_secrets", [{ name: "gh_token", value: "ghp_abc123def456ghi789jkl012", createdAt: 1 }]],
  ]);
  const sent: Array<{ type: string; command?: { kind: string } }> = [];
  const mock = makeChromeStorageMock(local, session);
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      id: "test",
      lastError: undefined,
      onMessage: { addListener: () => {} },
      getManifest: () => ({ permissions: ["storage", "tabs"], host_permissions: ["<all_urls>"] }),
      sendMessage: (msg: unknown) => {
        const m = msg as { type: string; command: { kind: string } };
        sent.push({ type: m.type, command: m.command });
        if (m.type === "SCHEDULED_TASK_COMMAND") {
          return Promise.resolve(opts.scheduledTaskCommand?.(m.command.kind, m.command) ?? { ok: false, error: "unhandled" });
        }
        if (m.type === "HISTORY_COMMAND") {
          return Promise.resolve(opts.historyCommand?.(m.command.kind, m.command) ?? { ok: false, error: "unhandled" });
        }
        return Promise.resolve({ ok: false, error: `unhandled ${m.type}` });
      },
    },
    storage: mock.storage,
  } as unknown as typeof chrome;
  return { sent, session, local };
}

/** Click the confirmation modal's Cancel (first) button. */
function clickCancel(): void {
  const overlay = document.querySelector<HTMLDivElement>(".modal-overlay");
  const footer = overlay?.querySelectorAll<HTMLButtonElement>(".modal-footer button");
  footer?.[0]?.click();
}

/** Wait out the anti-misclick delay, then click the danger Confirm (last). */
async function clickConfirm(): Promise<void> {
  await new Promise((r) => setTimeout(r, 250));
  const overlay = document.querySelector<HTMLDivElement>(".modal-overlay");
  const footer = overlay?.querySelectorAll<HTMLButtonElement>(".modal-footer button");
  footer?.[footer.length - 1]?.click();
  await new Promise((r) => setTimeout(r, 0));
}


beforeEach(() => {
  vi.resetModules();
  mountOptionsDom();
});

afterEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
  document.body.innerHTML = "";
});

describe("Destructive-action safety", () => {
  test("delete scheduled task: cancel sends nothing, confirm sends exactly one typed command", async () => {
    const tasks = [
      { id: "t1", task: "report", schedule: { type: "daily", hour: 9, minute: 0 }, enabled: true, createdAt: 100, revision: 1 },
    ];
    const { sent } = setupChrome({
      scheduledTaskCommand: (kind) => {
        if (kind === "list") return { ok: true, tasks };
        if (kind === "delete") return { ok: true, tasks: [] };
        return { ok: true, tasks };
      },
    });

    const { renderSchedule } = await import("../src/extension/options/scheduled-tasks");
    await renderSchedule();
    const delBtn = document.querySelector<HTMLButtonElement>("button.schedule-delete");
    expect(delBtn).not.toBeNull();

    // Cancel path: the danger modal opens but no command is sent.
    delBtn?.click();
    await new Promise((r) => setTimeout(r, 0));
    const overlay = document.querySelector<HTMLDivElement>(".modal-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay?.querySelector(".modal-title")?.textContent).toContain("Delete scheduled task");
    clickCancel();
    await new Promise((r) => setTimeout(r, 0));
    expect(
      sent.some((m) => m.type === "SCHEDULED_TASK_COMMAND" && m.command?.kind === "delete"),
    ).toBe(false);
    expect(document.querySelector(".modal-overlay")).toBeNull();

    // The danger confirm is disabled during the anti-misclick window…
    delBtn?.click();
    await new Promise((r) => setTimeout(r, 0));
    const danger = document.querySelectorAll<HTMLButtonElement>(".modal-footer .btn-danger");
    expect(danger.length).toBe(1);
    expect(danger[0].disabled).toBe(true);
    // …and becomes enabled after the delay; confirming sends exactly one command.
    await new Promise((r) => setTimeout(r, 250));
    expect(danger[0].disabled).toBe(false);
    danger[0].click();
    await new Promise((r) => setTimeout(r, 0));
    const deletes = sent.filter(
      (m) => m.type === "SCHEDULED_TASK_COMMAND" && m.command?.kind === "delete",
    );
    expect(deletes).toHaveLength(1);
    expect(deletes[0].command).toMatchObject({ kind: "delete", taskId: "t1" });
  });


  test("clear history: cancel leaves the list, confirm clears through the worker", async () => {
    const runs = [
      { id: "r1", task: "demo", startedAt: 1, endedAt: 2, stepCount: 1, totalCostUsd: 0.1 },
    ];
    let currentRuns: unknown[] = runs;
    let cleared = false;
    const { sent } = setupChrome({
      historyCommand: (kind) => {
        if (kind === "list") return { ok: true, runs: currentRuns, revision: 1 };
        if (kind === "clear") { cleared = true; currentRuns = []; return { ok: true, runs: [], revision: 2 }; }
        return { ok: true, runs: currentRuns, revision: 1 };
      },
    });

    const { renderHistory } = await import("../src/extension/options/history");
    const { historyStore } = await import("../src/extension/options/stores");
    await renderHistory();
    const clearBtn = document.getElementById("clearHistory") as HTMLButtonElement;

    clearBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector(".modal-overlay")).not.toBeNull();
    clickCancel();
    await new Promise((r) => setTimeout(r, 0));
    expect(cleared).toBe(false);
    expect(historyStore.getState().entries).toHaveLength(1);
    expect(
      sent.some((m) => m.type === "HISTORY_COMMAND" && m.command?.kind === "clear"),
    ).toBe(false);

    clearBtn.click();
    await clickConfirm();
    expect(cleared).toBe(true);
    expect(historyStore.getState().entries).toHaveLength(0);
    expect(
      sent.filter((m) => m.type === "HISTORY_COMMAND" && m.command?.kind === "clear"),
    ).toHaveLength(1);
  });

  test("delete secret: requires explicit confirmation and the value stays masked while visible", async () => {
    const h = setupChrome({});
    const { renderSecrets } = await import("../src/extension/options/settings-sync-utils");
    await renderSecrets();

    const list = document.getElementById("secretsList") as HTMLDivElement;
    expect(list.textContent).toContain("%gh_token%");
    // Sensitive value must never render in plaintext.
    expect(list.textContent).not.toContain("ghp_abc123def456ghi789jkl012");
    expect(list.querySelector(".secret-delete")).not.toBeNull();

    // Cancel keeps the secret.
    (list.querySelector<HTMLButtonElement>(".secret-delete"))?.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector(".modal-overlay")).not.toBeNull();
    clickCancel();
    await new Promise((r) => setTimeout(r, 0));
    const secrets = h.session.get("open_cowork_secrets") as Array<{ name: string }>;
    expect(secrets).toHaveLength(1);

    // Confirm deletes it.
    (list.querySelector<HTMLButtonElement>(".secret-delete"))?.click();
    await clickConfirm();
    const after = h.session.get("open_cowork_secrets") as Array<{ name: string }>;
    expect(after).toHaveLength(0);
    expect((document.getElementById("secretsList") as HTMLDivElement).textContent).toContain("No secrets stored");
  });
});
