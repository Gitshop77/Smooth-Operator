/**
 * Import validators in `options/history.ts`.
 *
 * `history.ts` wires element listeners + imports `settings-sync.ts` at import
 * time, so we stub `chrome` and create the minimal element set before the
 * dynamic import (mirrors settings-sync.test.ts / log-renderer.test.ts).
 */

import { describe, test, expect, beforeAll } from "vitest";
import { makeChromeStorageMock } from "./helpers/chrome-storage-mock";
import type { RunHistoryEntry } from "../src/extension/options/history-utils";

function setupGlobals(): void {
  const localStore = new Map<string, unknown>();
  const sessionStore = new Map<string, unknown>();
  (globalThis as unknown as { chrome: unknown }).chrome = makeChromeStorageMock(localStore, sessionStore);

  // Settings-sync element set (history.ts imports settings-sync).
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
    <div id="historyList"></div>
    <button id="clearHistory"></button>
    <button id="exportHistory"></button>
    <button id="importHistory"></button>
    <input id="importHistoryFile">
  `;
}

const validEntry = () => ({
  task: "demo",
  startedAt: 1,
  endedAt: 2,
  stepCount: 1,
  totalCostUsd: 0.1,
});

describe("history import validators", () => {
  let isRunHistoryEntry: (v: unknown) => boolean;
  let MAX_RUN_ENTRY_BYTES: number;

  beforeAll(async () => {
    setupGlobals();
    const mod = await import("../src/extension/options/history");
    isRunHistoryEntry = mod.isRunHistoryEntry;
    MAX_RUN_ENTRY_BYTES = mod.MAX_RUN_ENTRY_BYTES;
  });

  test("entry without result is valid", () => {
    expect(isRunHistoryEntry(validEntry())).toBe(true);
  });

  test("entry with result.success but missing result.text is rejected", () => {
    expect(isRunHistoryEntry({ ...validEntry(), result: { success: true } })).toBe(false);
  });

  test("entry with non-finite numeric field is rejected", () => {
    expect(isRunHistoryEntry({ ...validEntry(), startedAt: "x" })).toBe(false);
  });

  test("oversized entry (3 MiB) is dropped but a valid entry passes", () => {
    const big = {
      ...validEntry(),
      transcript: "x".repeat(3_000_000),
    };
    const small = { ...validEntry(), transcript: "ok" };
    const passes = (e: unknown) =>
      isRunHistoryEntry(e) && JSON.stringify(e).length <= MAX_RUN_ENTRY_BYTES;
    expect(passes(small)).toBe(true);
    expect(passes(big)).toBe(false);
  });
});

describe("capTranscript", () => {
  let capTranscript: (run: RunHistoryEntry) => string;
  let MAX_TRANSCRIPT_CHARS: number;

  beforeAll(async () => {
    const mod = await import("../src/extension/options/history-utils");
    capTranscript = mod.capTranscript;
    MAX_TRANSCRIPT_CHARS = mod.MAX_TRANSCRIPT_CHARS;
  });

  test("small runs pass through unchanged", () => {
    const run: RunHistoryEntry = {
      task: "hi",
      startedAt: 1,
      endedAt: 2,
      stepCount: 1,
      totalCostUsd: 0.1,
      transcript: { ok: true },
    };
    expect(capTranscript(run)).toBe(JSON.stringify(run, null, 2));
  });

  test("oversized transcripts are capped with an explicit marker", () => {
    const run: RunHistoryEntry = {
      task: "big",
      startedAt: 1,
      endedAt: 2,
      stepCount: 1,
      totalCostUsd: 0.1,
      transcript: "y".repeat(200_000),
    };
    const out = capTranscript(run);
    expect(out.length).toBeLessThan(MAX_TRANSCRIPT_CHARS + 120);
    expect(out).toContain("(truncated:");
    expect(out).toContain("remains in storage");
  });

  test("the cap cut is code-point-aware (no lone surrogates)", () => {
    const run: RunHistoryEntry = {
      task: "emoji",
      startedAt: 1,
      endedAt: 2,
      stepCount: 1,
      totalCostUsd: 0.1,
      transcript: "😀".repeat(120_000),
    };
    const out = capTranscript(run);
    expect(out.includes("\uFFFD")).toBe(false);
  });
});
