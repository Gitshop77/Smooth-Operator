/**
 * Custom-tools add flow: the 50-tool cap is enforced with a styled modal and
 * storage is left untouched at the limit.
 *
 * `custom-tools.ts` imports `settings-sync.ts` (which runs storage + DOM
 * side-effects at import time), so the full settings element set is created
 * before the dynamic import (mirrors history.test.ts).
 */

import { describe, test, expect, beforeAll } from "vitest";
import { makeChromeStorageMock } from "./helpers/chrome-storage-mock";
import { STORAGE_KEYS } from "../src/extension/options/storage-keys";
import { MAX_CUSTOM_TOOLS } from "../src/extension/options/custom-tools-utils";

let localStore: Map<string, unknown>;
let sessionStore: Map<string, unknown>;

function setupDom(): void {
  localStore = new Map<string, unknown>();
  sessionStore = new Map<string, unknown>();
  (globalThis as unknown as { chrome: unknown }).chrome = makeChromeStorageMock(localStore, sessionStore);

  document.body.innerHTML = `
    <select id="provider"></select>
    <button id="testConnection"></button>
    <input id="model">
    <span id="provider-hint"></span>
    <input id="apiKey">
    <span id="apikey-hint"></span>
    <label id="baseurl-label"></label>
    <input id="baseUrl">
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
    <input id="toolName">
    <textarea id="toolDesc"></textarea>
    <textarea id="toolCode"></textarea>
    <button id="addTool"></button>
    <div id="toolsList"></div>
    <div id="toolPermissions"></div>
  `;
}

function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (cond()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("timed out waiting for condition"));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("custom-tools add cap", () => {
  beforeAll(async () => {
    setupDom();
    // Seed the store at the cap BEFORE the module import so the add flow sees
    // a full store on first use.
    localStore.set(
      STORAGE_KEYS.customTools,
      Array.from({ length: MAX_CUSTOM_TOOLS }, (_, i) => ({
        name: `tool_${String(i).padStart(2, "0")}`,
        description: `desc ${i}`,
        code: "return 1;",
        createdAt: i,
        codeHash: "ab12",
      })),
    );
    await import("../src/extension/options/custom-tools");
  });

  test("adding a tool at the 50-cap is blocked with the limit modal", async () => {
    (document.getElementById("toolName") as HTMLInputElement).value = "tool_50";
    (document.getElementById("toolDesc") as HTMLTextAreaElement).value = "desc 50";
    (document.getElementById("toolCode") as HTMLTextAreaElement).value = "return 1;";

    (document.getElementById("addTool") as HTMLButtonElement).click();

    // The danger confirm ("Save tool") is delay-enabled (200ms) — wait for it.
    await waitFor(() => {
      const btn = document.querySelector<HTMLButtonElement>(".modal-footer .btn-danger");
      return !!btn && !btn.disabled;
    });
    document.querySelector<HTMLButtonElement>(".modal-footer .btn-danger")!.click();

    // The cap alert must surface with the limit message.
    await waitFor(() =>
      document.querySelector<HTMLElement>(".modal-body")?.textContent?.includes("Delete one before adding another.") ?? false,
    );
    expect(document.querySelector<HTMLElement>(".modal-title")?.textContent).toContain("Tool limit reached");
    expect(document.querySelector<HTMLElement>(".modal-body")?.textContent).toContain(String(MAX_CUSTOM_TOOLS));

    // Storage is untouched — still exactly at the cap.
    const stored = localStore.get(STORAGE_KEYS.customTools) as unknown[];
    expect(stored.length).toBe(MAX_CUSTOM_TOOLS);
    expect(stored.some((t) => (t as { name: string }).name === "tool_50")).toBe(false);
  });
});
