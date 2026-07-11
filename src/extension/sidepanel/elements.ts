/**
 * sidepanel/elements.ts — DOM element refs for the side panel.
 *
 * Extracted into its own module to break the circular dependency between
 * index.ts (which defines the elements) and the sibling modules (controls,
 * log-renderer, takeover, etc. which use them at module top level).
 *
 * Without this, ES module evaluation order means the sibling modules run
 * before index.ts has initialized the `export const` bindings — the imports
 * are `undefined` and `addEventListener` throws.
 */

import { $ } from "@/extension/shared";

export const taskInput = $<HTMLTextAreaElement>("task");
export const runBtn = $<HTMLButtonElement>("runBtn");
export const stopBtn = $<HTMLButtonElement>("stopBtn");
export const pauseBtn = document.getElementById("pauseBtn") as HTMLButtonElement | null;
export const logEl = $<HTMLDivElement>("log");
export const stepLabel = $<HTMLSpanElement>("stepLabel");
export const countLabel = $<HTMLSpanElement>("countLabel");
export const barFill = $<HTMLSpanElement>("barFill");
export const liveDot = $<HTMLSpanElement>("liveDot");
export const costLabel = $<HTMLSpanElement>("costLabel");
export const tokenLabel = $<HTMLSpanElement>("tokenLabel");
export const openOptionsLink = document.getElementById("openOptions") as HTMLAnchorElement | null;
export const takeoverBanner = document.getElementById("takeoverBanner") as HTMLDivElement | null;
export const takeoverReason = document.getElementById("takeoverReason") as HTMLDivElement | null;
export const resumeBtn = document.getElementById("resumeBtn") as HTMLButtonElement | null;

export const modeSelect = document.getElementById("modeSelect") as HTMLSelectElement | null;
export const statusIcon = document.getElementById("statusIcon") as HTMLSpanElement | null;
export const statusLabel = document.getElementById("statusLabel") as HTMLSpanElement | null;
export const taskBadge = document.getElementById("taskBadge") as HTMLSpanElement | null;
export const thinkingPanel = document.getElementById("reasoning") as HTMLDetailsElement | null;
export const thinkingBody = document.getElementById("thinkingBody") as HTMLDivElement | null;
export const thinkingHint = document.getElementById("thinkingHint") as HTMLSpanElement | null;

export const costProjectionEl = document.getElementById("costProjection") as HTMLDivElement | null;
export const costPerStepEl = document.getElementById("costPerStep") as HTMLSpanElement | null;
export const costCapInfoEl = document.getElementById("costCapInfo") as HTMLSpanElement | null;

export const modelSwitchInput = document.getElementById("modelSwitchInput") as HTMLInputElement | null;
export const modelSwitchBtn = document.getElementById("modelSwitchBtn") as HTMLButtonElement | null;
export const debugModeCheckbox = document.getElementById("debugMode") as HTMLInputElement | null;
export const openCockpitBtn = document.getElementById("open-cockpit-btn") as HTMLButtonElement | null;

// Mutable shared state (live bindings — sibling modules read/write these)
export let maxSteps = 100;
export let currentMode = "standard" as string;
export let costCapUsd = 0;

export function setMaxSteps(v: number): void { maxSteps = v; }
export function setCurrentMode(v: string): void { currentMode = v; }
export function setCostCapUsd(v: number): void { costCapUsd = v; }

export const STORAGE_KEYS = {
  task: "task",
  agentMode: "agentMode",
  maxSteps: "maxSteps",
  costUsd: "__oc_costUsd",
  tokens: "__oc_tokens",
  log: "__oc_log",
  reasoningCollapse: "cw-reasoning",
  activityCollapse: "cw-activity",
} as const;
