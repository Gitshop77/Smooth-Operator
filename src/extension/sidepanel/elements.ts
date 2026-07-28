/**
 * sidepanel/elements.ts — DOM element refs for the side panel.
 *
 * Extracted into its own module to break the circular dependency between
 * index.ts (which defines the elements) and the sibling modules (controls,
 * chat-renderer, takeover, etc. which use them at module top level).
 */

import { $ } from "@/extension/shared";

// Resolution contract (documents the deliberately-mixed strategy so reviewers
// aren't surprised):
// • `$("id")` is used for elements that MUST exist for the side panel to
// function. It throws on a missing id, which fails fast at load — the HTML
// (sidepanel.html) is the single source of truth for these ids, and the
// consumers dereference them unconditionally by design.
// • `document.getElementById("id")` (nullable) is used for OPTIONAL elements
// (takeover banner, password prompt). Consumers guard these with `?`.
// Mixing the two is intentional, NOT an oversight: required refs fail closed,
// optional refs degrade gracefully. Do not "standardise" one to the other
// without updating every consumer.

export const chatMessages = $<HTMLDivElement>("chatMessages");
export const messageInput = $<HTMLTextAreaElement>("messageInput");
export const sendBtn = $<HTMLButtonElement>("sendBtn");
export const stopBtn = $<HTMLButtonElement>("stopBtn");
export const costLabel = $<HTMLSpanElement>("costLabel");
export const tokenLabel = $<HTMLSpanElement>("tokenLabel");
export const statusLabel = $<HTMLSpanElement>("statusLabel");
export const statusDot = $<HTMLSpanElement>("statusDot");
export const modeSelect = document.getElementById("modeSelect") as HTMLSelectElement | null;
export const openOptionsLink = document.getElementById("openOptions") as HTMLButtonElement | null;
export const takeoverBanner = document.getElementById("takeoverBanner") as HTMLDivElement | null;
export const takeoverReason = document.getElementById("takeoverReason") as HTMLDivElement | null;
export const resumeBtn = document.getElementById("resumeBtn") as HTMLButtonElement | null;

export const STORAGE_KEYS = {
  task: "task",
  agentMode: "agentMode",
  maxSteps: "maxSteps",
  costUsd: "__oc_costUsd",
  tokens: "__oc_tokens",
  log: "__oc_log",
  // Kept in sync with the canonical options-side map (settings-sync.ts) so the
  // side panel can reference these keys without hardcoding literals. The actual
  // persistence for these two is owned by the options page.
  costCap: "costCap",
  defaultTask: "defaultTask",
} as const;

// Mutable shared state (live bindings — sibling modules read/write these)
export let currentMode = "standard" as string;
export let maxSteps = 100 as number;

/** Update the agent mode + persist to chrome.storage. */
export function setCurrentMode(v: string): void {
  currentMode = v;
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    void chrome.storage.local.set({ [STORAGE_KEYS.agentMode]: v });
  }
}

// Read persisted settings from chrome.storage on init.
if (typeof chrome !== "undefined" && chrome.storage?.local) {
  chrome.storage.local.get([STORAGE_KEYS.agentMode, STORAGE_KEYS.maxSteps], (s) => {
    if (s?.[STORAGE_KEYS.agentMode]) {
      currentMode = s[STORAGE_KEYS.agentMode] as string;
      if (modeSelect) modeSelect.value = currentMode;
    }
    if (typeof s?.[STORAGE_KEYS.maxSteps] === "number") {
      maxSteps = s[STORAGE_KEYS.maxSteps] as number;
    }
  });

  // Sync when settings change in another tab (e.g. Options page).
  if (chrome.storage.onChanged?.addListener) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[STORAGE_KEYS.agentMode]?.newValue != null) {
        currentMode = changes[STORAGE_KEYS.agentMode].newValue as string;
        if (modeSelect) modeSelect.value = currentMode;
      }
      if (changes[STORAGE_KEYS.maxSteps]?.newValue != null) {
        maxSteps = changes[STORAGE_KEYS.maxSteps].newValue as number;
      }
    });
  }
}
