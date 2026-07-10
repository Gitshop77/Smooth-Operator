/**
 * sidepanel/index.ts — entry point for the side panel UI logic.
 *
 * Bundled via esbuild to `sidepanel.js`. Sends RUN/STOP messages to the
 * background service worker and renders the stream of AGENT_EVENT messages
 * as a live activity log with cost + token tracking.
 *
 * Element refs and shared state live in `./elements` (extracted to break the
 * circular dependency between this module and the sibling modules that use
 * the elements at module top level).
 */

import type { AgentMode } from "@/lib/agent/modes";
import { getCockpitUrl } from "@/extension/shared";
import {
  currentMode,
  taskInput,
  modeSelect,
  openOptionsLink,
  openCockpitBtn,
  debugModeCheckbox,
  STORAGE_KEYS,
  setMaxSteps,
  setCurrentMode,
  setCostCapUsd,
} from "./elements";

// Re-export everything from elements for backward compatibility.
export * from "./elements";

// Import sibling modules for their top-level side effects (onMessage listener
// registration + addEventListener calls). ES module evaluation order ensures
// every listener is wired before any user interaction can fire — now safe
// because elements.ts has no circular dependencies.
import "./log-renderer";
import "./controls";
import "./takeover";
import "./human-interact";
import "./lifecycle";

// Port-based service-worker keepalive — keeps the SW alive while the side
// panel is open so long LLM streams aren't cut off mid-response.
function connectKeepalivePort(): void {
  try {
    const port = chrome.runtime.connect({ name: "keepalive" });
    port.onDisconnect.addListener(() => {
      setTimeout(connectKeepalivePort, 1000);
    });
  } catch {
    setTimeout(connectKeepalivePort, 1000);
  }
}
connectKeepalivePort();

// ─── Hydrate from chrome.storage.local ─────────────────────────────────────

chrome.storage.local.get([STORAGE_KEYS.task, STORAGE_KEYS.agentMode, STORAGE_KEYS.maxSteps, "costCap", "defaultTask"], (res) => {
  if (chrome.runtime.lastError) {
    console.warn("[sidepanel] storage.get failed:", chrome.runtime.lastError);
    return;
  }
  if (res.task) taskInput.value = res.task as string;
  if (typeof res.defaultTask === "string" && res.defaultTask.trim()) {
    taskInput.placeholder = res.defaultTask;
  }
  setCostCapUsd((res.costCap as number) || 0);
  if (res.agentMode) {
    setCurrentMode(res.agentMode as string);
    syncModeDropdown();
  }
  if (typeof res.maxSteps === "number") setMaxSteps(res.maxSteps);
});

// ─── Mode selector ─────────────────────────────────────────────────────────

function syncModeDropdown(): void {
  if (modeSelect && modeSelect.value !== currentMode) modeSelect.value = currentMode;
}

modeSelect?.addEventListener("change", () => {
  const mode = modeSelect?.value as AgentMode | undefined;
  if (!mode) return;
  setCurrentMode(mode);
  chrome.storage.local.set({ [STORAGE_KEYS.agentMode]: mode }, () => {
    if (chrome.runtime.lastError) console.warn("[sidepanel] set agentMode failed:", chrome.runtime.lastError);
  });
  syncModeDropdown();
});

taskInput.addEventListener("change", () =>
  chrome.storage.local.set({ [STORAGE_KEYS.task]: taskInput.value }, () => {
    if (chrome.runtime.lastError) console.warn("[sidepanel] set task failed:", chrome.runtime.lastError);
  })
);

document.querySelectorAll<HTMLButtonElement>(".preset").forEach((el) => {
  el.addEventListener("click", () => {
    taskInput.value = el.dataset.task || "";
    chrome.storage.local.set({ [STORAGE_KEYS.task]: taskInput.value }, () => {
      if (chrome.runtime.lastError) console.warn("[sidepanel] set task failed:", chrome.runtime.lastError);
    });
  });
});

openOptionsLink?.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
});

// ─── Open Cowork Cockpit button ───────────────────────────────────────────

openCockpitBtn?.addEventListener("click", async () => {
  const cockpitUrl = await getCockpitUrl();
  // Check if the cockpit is actually running BEFORE opening the tab,
  // so we can show a helpful notification instead of a dead page.
  let isRunning = false;
  try {
    await fetch(cockpitUrl, { mode: "no-cors", signal: AbortSignal.timeout(2000) });
    isRunning = true;
  } catch {
    isRunning = false;
  }
  if (isRunning) {
    try {
      await chrome.tabs.create({ url: cockpitUrl });
    } catch (err) {
      console.warn("[sidepanel] failed to open cockpit tab:", err);
    }
  } else {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon.png",
      title: "Open Cowork — Cockpit not running",
      message: "The Cockpit dashboard needs to be started separately.\n\nIn a terminal, run:\n  npm run dev:cockpit\n\nThen click this button again.",
      priority: 2,
    }, () => { /* non-fatal */ });
  }
});

// Debug highlight toggle
debugModeCheckbox?.addEventListener("change", () => {
  const enabled = debugModeCheckbox?.checked ?? false;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, { type: "SET_DEBUG_HIGHLIGHT", enabled }).catch(() => {});
    }
  });
});

// ─── Populate the mid-run model-switch datalist ─────────────────────────────

(async () => {
  try {
    const res = await chrome.storage.local.get("provider");
    const provider = (res.provider as string | undefined) ?? "openai";
    const { getModelsForProvider, formatCost, formatContext, formatVision } =
      await import("../../lib/agent/llm/catalog");
    const { CATALOG_PROVIDER_ID_MAP } = await import("../provider-config-map");
    const catId = CATALOG_PROVIDER_ID_MAP[provider];
    if (!catId) return;
    const datalist = document.getElementById("model-suggestions-sp") as HTMLDataListElement | null;
    if (!datalist) return;
    const models = await getModelsForProvider(catId);
    datalist.innerHTML = "";
    for (const m of models.slice(0, 50)) {
      const opt = document.createElement("option");
      opt.value = m.id;
      const visionTag = formatVision(m.attachment);
      opt.label = `${m.name} · ${formatCost(m.cost)} · ${formatContext(m.limit)}${visionTag ? " · " + visionTag : ""}`;
      datalist.appendChild(opt);
    }
  } catch {
    // Catalog unavailable — datalist stays empty.
  }
})();
