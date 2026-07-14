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

/** The set of agent modes the side panel will accept from storage. */
const ALLOWED_MODES = new Set(["full_agentic", "standard", "restricted"]);

/** Persist the task text to storage, logging a warning on failure. */
function persistTask(value: string): void {
  chrome.storage.local.set({ [STORAGE_KEYS.task]: value }, () => {
    if (chrome.runtime.lastError) console.warn("[sidepanel] set task failed:", chrome.runtime.lastError);
  });
}

// ─── Collapse-state persistence (BOTH Reasoning + Activity) ─────────────────
//
// P2 both the Reasoning and Activity <details> panels remember their
// open/closed state across panel close/reopen via chrome.storage.local
// (keys cw-reasoning / cw-activity). Restored on load, then a `toggle`
// listener persists every change. This is the side-panel equivalent of the
// localStorage demo in preview.html, but uses chrome.storage so it survives
// the extension's isolated world.

interface CollapseBinding {
  id: string;
  key: string;
}

const COLLAPSE_BINDINGS: CollapseBinding[] = [
  { id: "reasoning", key: STORAGE_KEYS.reasoningCollapse },
  { id: "activity", key: STORAGE_KEYS.activityCollapse },
];

function bindCollapsePersistence(): void {
  const keys = COLLAPSE_BINDINGS.map((b) => b.key);
  chrome.storage.local.get(keys, (res) => {
    if (chrome.runtime.lastError) return;
    for (const { id, key } of COLLAPSE_BINDINGS) {
      const el = document.getElementById(id) as HTMLDetailsElement | null;
      if (!el) continue;
      const saved = res[key];
      if (saved === "closed") el.open = false;
      else if (saved === "open") el.open = true;
      el.addEventListener("toggle", () => {
        const value = el.open ? "open" : "closed";
        chrome.storage.local.set({ [key]: value }, () => {
          if (chrome.runtime.lastError) {
            /* best-effort persistence — non-fatal */
          }
        });
      });
    }
  });
}
bindCollapsePersistence();

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

chrome.storage.local.get(
  [STORAGE_KEYS.task, STORAGE_KEYS.agentMode, STORAGE_KEYS.maxSteps, STORAGE_KEYS.costCap, STORAGE_KEYS.defaultTask],
  (res) => {
    if (chrome.runtime.lastError) {
      console.warn("[sidepanel] storage.get failed:", chrome.runtime.lastError);
      return;
    }
    if (typeof res.task === "string") taskInput.value = res.task;
    if (typeof res.defaultTask === "string" && res.defaultTask.trim()) {
      taskInput.placeholder = res.defaultTask;
    }
 // Validate the cost-cap value: `chrome.storage` returns `unknown`, and a
 // corrupted / wrongly-typed payload (string, NaN, negative) would otherwise
 // flow straight into the cost-cap badge and render as "cap: NaN%".
    const rawCostCap = res.costCap;
    const costCapUsd =
      typeof rawCostCap === "number" && Number.isFinite(rawCostCap) && rawCostCap >= 0
        ? rawCostCap
        : 0;
    setCostCapUsd(costCapUsd);
 // Validate `agentMode` against the known set before adopting it. A corrupt
 // or legacy value in chrome.storage must not poison the mode state (the
 // typed `setCurrentMode` would otherwise broadcast an unrecognized mode to
 // the orchestrator). Fall back to the safe default when unrecognized.
    const mode = res.agentMode as string | undefined;
    if (mode && ALLOWED_MODES.has(mode)) {
      setCurrentMode(mode);
      syncModeDropdown();
    }
    if (typeof res.maxSteps === "number") setMaxSteps(res.maxSteps);
  },
);

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

taskInput.addEventListener("change", () => persistTask(taskInput.value));

document.querySelectorAll<HTMLButtonElement>(".preset").forEach((el) => {
  el.addEventListener("click", () => {
    taskInput.value = el.dataset.task || "";
    persistTask(taskInput.value);
  });
});

openOptionsLink?.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
});

// ─── Open Cowork Cockpit button ───────────────────────────────────────────

openCockpitBtn?.addEventListener("click", async () => {
  const cockpitUrl = await getCockpitUrl();
 // An unconfigured Cockpit URL yields ""; guard before the no-cors probe so
 // the user gets the setup hint instead of a swallowed chrome.tabs.create({url:""}).
  if (!cockpitUrl) {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon.png",
      title: "Open Cowork — Cockpit not configured",
      message: "Set the Cockpit URL in Settings, then start it with:\n  npm run dev:cockpit",
      priority: 2,
    }, () => {});
    return;
  }
 // Check if the cockpit is actually running BEFORE opening the tab,
 // so we can show a helpful notification instead of a dead page.
  let isRunning = false;
  try {
 // Best-effort connectivity probe. `mode: "no-cors"` makes the response
 // opaque, so we CANNOT inspect HTTP status — any host that answers the
 // TCP/TLS connection (captive portal, unrelated dev server, error page)
 // resolves the promise and is treated as "running". This is a known
 // limitation: we only confirm *something* is listening at the URL, not
 // that it's the Cockpit server. A definitive check would need a CORS-
 // enabled `/api/health` endpoint on the Cockpit server.
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

// Debug highlight overlay — a user opt-in debugging aid (default OFF in the
// sidepanel UI). It asks the active tab's content script to paint a transient
// highlight layer so an operator can verify which element the agent is about to
// act on. It is intentionally exposed in production as a support/debugging tool.
// The actual control here is two-fold: (1) the user must physically toggle the
// checkbox in the panel, and (2) the active tab must have an injected content
// script that handles the `SET_DEBUG_HIGHLIGHT` message (sendMessage rejects for
// `chrome://`, extension pages, or tabs without the content script — and we
// revert the checkbox + log on that failure). NOTE: this path does NOT invoke
// `chrome.debugger`; the `debugger` permission is consumed only by the
// screenshot/CDP paths (screenshots.ts, cdp-controller.ts, message-routing.ts).
// The comment previously claimed a `debugger`-permission gate that does not
// exist on this code path — corrected to describe the real controls.
debugModeCheckbox?.addEventListener("change", () => {
  const cb = debugModeCheckbox;
  if (!cb) return;
  const enabled = cb.checked;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs[0]?.id;
 // No active tab (e.g. the caller is the target window without a focused
 // tab). Surface it and revert so the checkbox doesn't lie.
    if (!tabId) {
      console.warn("[sidepanel] debug highlight: no active tab to message");
      cb.checked = !enabled;
      return;
    }
    chrome.tabs
      .sendMessage(tabId, { type: "SET_DEBUG_HIGHLIGHT", enabled })
      .catch((err) => {
 // Every failure mode (no content script injected, a chrome:// or
 // other privileged page, the tab having been closed) lands here.
 // Log it so the operator has a diagnostic path, and revert the
 // checkbox so the UI reflects reality instead of showing "on" with
 // no highlight applied. Setting .checked programmatically does not
 // re-fire the change event, so this won't recurse.
        console.warn(
          `[sidepanel] debug highlight ${enabled ? "enable" : "disable"} failed — no content script or unsupported page:`,
          err
        );
        cb.checked = !enabled;
      });
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
