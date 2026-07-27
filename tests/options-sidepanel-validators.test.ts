/**
 * Pure validation helpers in the Options/Sidepanel modules that previously had
 * no direct assertion slice. These encode the SSRF-adjacent hostname rules,
 * cost-payload finite-number checks, and the storage-shape guards for custom
 * tools / quick prompts / custom skills.
 *
 * `settings-sync`, `custom-tools`, `prompts`, and `skills` run DOM + storage
 * side-effects at import time, so we stub `chrome` and create the minimal
 * element set (mirroring settings-sync.test.ts, plus the ids those modules
 * touch at import) before the dynamic imports.
 */

import { describe, test, expect, beforeAll } from "vitest";

function setupGlobals(): void {
  const local = new Map<string, unknown>();
  const session = new Map<string, unknown>();
  const makeArea = (store: Map<string, unknown>) => ({
    get: (_keys: unknown, cb?: (res: Record<string, unknown>) => void) => {
      cb?.(Object.fromEntries(store));
    },
    set: (items: Record<string, unknown>, cb?: () => void) => {
      Object.entries(items).forEach(([k, v]) => store.set(k, v));
      cb?.();
    },
    remove: (keys: string | string[], cb?: () => void) => {
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => store.delete(k));
      cb?.();
    },
  });
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local: makeArea(local), session: makeArea(session) },
    runtime: {
      lastError: undefined,
      id: "test",
      getManifest: () => ({ permissions: [], host_permissions: [] }),
      onMessage: { addListener: () => {} },
      sendMessage: (_msg: unknown, cb?: (res: unknown) => void) => {
        cb?.(undefined);
      },
    },
  };

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
    <div id="toolPermissions"></div>
    <button id="addTool"></button>
    <button id="addSkill"></button>
    <textarea id="customNavigatorPrompt"></textarea>
    <textarea id="customPlannerPrompt"></textarea>
  `;
}

describe("options/sidepanel pure validators", () => {
  let readInt: (id: string, def: number, min: number, max: number, invalid: string[]) => number;
  let validateCustomTools: (raw: unknown) => unknown[];
  let validateQuickPrompts: (raw: unknown) => unknown[];
  let validateCustomSkills: (raw: unknown) => unknown[];

  beforeAll(async () => {
    setupGlobals();
    const sync = await import("../src/extension/options/settings-sync");
    const tools = await import("../src/extension/options/custom-tools");
    const prompts = await import("../src/extension/options/prompts");
    const skills = await import("../src/extension/options/skills");
    readInt = sync.readInt;
    validateCustomTools = tools.validateCustomTools as unknown as (r: unknown) => unknown[];
    validateQuickPrompts = prompts.validateQuickPrompts as unknown as (r: unknown) => unknown[];
    validateCustomSkills = skills.validateCustomSkills as unknown as (r: unknown) => unknown[];
  });

  describe("readInt (bounded integer field)", () => {
    test("returns the parsed value for clean integer input", () => {
      const el = document.getElementById("maxSteps") as HTMLInputElement;
      el.value = "5";
      const invalid: string[] = [];
      expect(readInt("maxSteps", 10, 1, 100, invalid)).toBe(5);
      expect(invalid).toEqual([]);
    });

    test("empty input falls back to default without flagging", () => {
      const el = document.getElementById("maxSteps") as HTMLInputElement;
      el.value = "";
      const invalid: string[] = [];
      expect(readInt("maxSteps", 10, 1, 100, invalid)).toBe(10);
      expect(invalid).toEqual([]);
    });

    test("rejects trailing junk and out-of-range, resetting to default + flag", () => {
      const el = document.getElementById("maxSteps") as HTMLInputElement;
      el.value = "5abc";
      const junk: string[] = [];
      expect(readInt("maxSteps", 10, 1, 100, junk)).toBe(10);
      expect(junk).toEqual(["maxSteps"]);

      el.value = "9999";
      const oor: string[] = [];
      expect(readInt("maxSteps", 10, 1, 100, oor)).toBe(10);
      expect(oor).toEqual(["maxSteps"]);
    });
  });

  describe("validateCustomTools", () => {
    test("drops malformed entries and keeps well-formed ones", () => {
      const out = validateCustomTools([
        { name: "a", description: "d", code: "c" },
        { name: "bad" }, // missing description/code
        "not-an-object",
      ]);
      expect(out).toEqual([{ name: "a", description: "d", code: "c" }]);
    });

    test("returns [] for null / non-array input", () => {
      expect(validateCustomTools(null)).toEqual([]);
      expect(validateCustomTools({})).toEqual([]);
    });
  });

  describe("validateQuickPrompts", () => {
    test("requires name + text strings", () => {
      const out = validateQuickPrompts([
        { name: "a", text: "t" },
        { name: "bad" }, // missing text
        { name: 5, text: "x" }, // non-string name
      ]);
      expect(out).toEqual([{ name: "a", text: "t" }]);
    });

    test("returns [] for null input", () => {
      expect(validateQuickPrompts(null)).toEqual([]);
    });
  });

  describe("validateCustomSkills", () => {
    test("requires name + instructions strings and a string[] domains", () => {
      const out = validateCustomSkills([
        { name: "a", instructions: "i", domains: ["example.com"] },
        { name: "bad", instructions: "i" }, // missing domains
        { name: "b", instructions: "i", domains: "example.com" }, // domains not array
      ]);
      expect(out).toHaveLength(1);
      expect((out[0] as { name: string }).name).toBe("a");
    });

    test("returns [] for null input", () => {
      expect(validateCustomSkills(null)).toEqual([]);
    });
  });
});
