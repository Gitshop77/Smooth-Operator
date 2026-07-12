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

// Resolution contract (documents the deliberately-mixed strategy so reviewers
// aren't surprised):
//   • `$("id")` is used for elements that MUST exist for the side panel to
//     function. It throws on a missing id, which fails fast at load — the HTML
//     (sidepanel.html) is the single source of truth for these ids, and the
//     consumers (`index.ts`, `controls.ts`, `log-renderer.ts`) dereference them
//     unconditionally by design.
//   • `document.getElementById("id")` (nullable) is used for OPTIONAL elements
//     (pause/resume controls, takeover banner, cost projection, model switch,
//     debug toggle). Consumers guard these with `?.`.
// Mixing the two is intentional, NOT an oversight: required refs fail closed,
// optional refs degrade gracefully. Do not "standardise" one to the other
// without updating every consumer, or you'll either crash the panel on a
// missing optional id or silently break a required-ref consumer.

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

// Accessibility: the model-switch input is not always wrapped in a <label> and
// a placeholder is NOT a substitute for an accessible name. Give it a stable
// programmatic name so screen readers announce its purpose ("Switch model
// mid-run"). We set it defensively here (a sibling module may consume the ref)
// only when markup hasn't already provided one. This keeps the side panel usable
// even if the HTML variant omits the label — the behavioral fix the audit asked
// for without editing the markup directly.
if (
  modelSwitchInput &&
  !modelSwitchInput.getAttribute("aria-label") &&
  !modelSwitchInput.getAttribute("aria-labelledby")
) {
  modelSwitchInput.setAttribute("aria-label", "Switch model mid-run");
}
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
  // Kept in sync with the canonical options-side map (settings-sync.ts) so the
  // side panel can reference these keys without hardcoding literals. The actual
  // persistence for these two is owned by the options page.
  costCap: "costCap",
  defaultTask: "defaultTask",
} as const;
