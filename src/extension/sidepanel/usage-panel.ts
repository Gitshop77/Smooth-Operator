/**
 * sidepanel/usage-panel.ts — run usage/cost surface for the side panel.
 *
 * Renders the run's accumulated usage (tokens in/out, reasoning tokens, cache
 * tokens, USD) plus the latest call against the effective context
 * limit. The service worker accumulates `cost` events into `RunState.usage`
 * (see agent-bridge.ts + state-store-utils.ts); this panel is render-only — it
 * reads run state from chrome.storage.session and re-renders on storage change,
 * keeping the last run's totals visible after the run ends.
 *
 * Imported by sidepanel/index.ts for its side effects (like the sibling
 * modules); the pure helpers are exported for tests.
 */

import {
  RUN_STATE_KEY,
  getRunState,
  zeroRunUsage,
  type RunState,
  type RunUsage,
} from "@/extension/background/state-store-utils";
import { getModelsForProvider } from "@/lib/agent/llm/catalog";
import { getPricingForModel } from "@/lib/agent/llm/pricing";
import { CATALOG_PROVIDER_ID_MAP } from "@/extension/provider-config-map";
import { subscribeRunView } from "./run-store";

// ─── Presentational helpers (pure) ─────────────────────────────────────────

/**
 * Output tokens excluding reasoning/thinking tokens. Gemini counts thoughts
 * inside `tokensOut` too, so subtracting keeps the completion-only figure and
 * the context-meter share from double-counting.
 */
export function completionTokens(usage: { tokensOut: number; reasoningTokens?: number }): number {
  return Math.max(0, usage.tokensOut - (usage.reasoningTokens ?? 0));
}

/**
 * Share of the model's context window consumed by the CURRENT (last) prompt:
 * `lastTokensIn / contextLimit`. The provider's input-token count IS the
 * prompt's context consumption — after compaction the next navigator call
 * sends a smaller prompt, so the meter drops live. Returns 0 when no context
 * limit is available.
 */
export function contextUsagePct(
  usage: { tokensIn: number },
  contextLimit: number | undefined,
): number {
  if (typeof contextLimit !== "number" || !Number.isFinite(contextLimit) || contextLimit <= 0) return 0;
  const pct = (usage.tokensIn / contextLimit) * 100;
  return Math.min(100, Math.max(0, pct));
}

/**
 * True when the last-reported model has no catalog pricing entry (cost was
 * estimated at the unknown-model fallback rate). Surfaces the fallback to the
 * user so a flat $ estimate isn't mistaken for provider pricing.
 */
export function isUncataloguedModel(model: string): boolean {
  if (!model) return false;
  return getPricingForModel(model).uncatalogued === true;
}

// ─── DOM surface ───────────────────────────────────────────────────────────

const USAGE_PANEL_STYLES = `
#usagePanel { display: flex; flex-direction: column; gap: 4px; padding: 8px 12px; border-top: 1px solid rgba(128,128,128,.25); font-size: 11px; line-height: 1.4; }
#usagePanel[hidden] { display: none; }
.usage-meter-row { display: flex; align-items: center; gap: 8px; }
.usage-meter-label { flex: 0 0 auto; opacity: .7; }
.usage-meter-track { flex: 1 1 auto; height: 4px; border-radius: 2px; background: rgba(128,128,128,.25); overflow: hidden; }
.usage-meter-fill { height: 100%; border-radius: 2px; background: #00b4d8; transform: scaleX(0); transform-origin: left; transition: transform .3s ease; }
.usage-meter-value { flex: 0 0 auto; min-width: 40px; text-align: right; opacity: .85; }
.usage-totals { opacity: .75; overflow-wrap: anywhere; }
`;

function injectStyles(): void {
  if (document.getElementById("usagePanelStyles")) return;
  const style = document.createElement("style");
  style.id = "usagePanelStyles";
  style.textContent = USAGE_PANEL_STYLES;
  document.head.appendChild(style);
}

function createPanel(): HTMLDivElement {
  const panel = document.createElement("div");
  panel.id = "usagePanel";
  panel.className = "usage-panel";
  panel.hidden = true;
  panel.setAttribute("aria-label", "Run usage");
  panel.innerHTML = `
    <div class="usage-meter-row">
      <span class="usage-meter-label">Context window</span>
      <div class="usage-meter-track"><div class="usage-meter-fill" id="usageMeterFill"></div></div>
      <span class="usage-meter-value" id="usageMeterValue"></span>
    </div>
    <div class="usage-totals" id="usageTotals"></div>
  `;
  return panel;
}

let panelEl: HTMLDivElement | null = null;
let lastUsage: RunUsage | null = null;
let renderGeneration = 0;
let snapshotDriven = false;
/** Memoized `provider` storage value — quasi-static, invalidated on change. */
let cachedProvider: string | null = null;
let cachedContextOverride: number | null | undefined;

function usageHasContent(usage: RunUsage): boolean {
  return usage.model !== "" || usage.costUsd > 0;
}

function formatUsd(v: number): string {
  return `$${v.toFixed(4)}`;
}

function formatTokens(v: number): string {
  return v.toLocaleString("en-US");
}

async function contextLimitFor(model: string): Promise<number | undefined> {
  if (!model) return undefined;
  if (typeof chrome === "undefined" || !chrome.storage?.local) return undefined;
  if (cachedProvider === null) {
    try {
      const res = await chrome.storage.local.get(["provider", "contextTokens"]);
      cachedProvider = typeof res.provider === "string" ? res.provider : "";
      cachedContextOverride = typeof res.contextTokens === "number" && res.contextTokens > 0
        ? res.contextTokens
        : null;
    } catch {
      cachedProvider = "";
      cachedContextOverride = null;
    }
  }
  if (cachedContextOverride) return cachedContextOverride;
  const catalogId = CATALOG_PROVIDER_ID_MAP[cachedProvider] ?? cachedProvider;
  return getModelsForProvider(catalogId, model)?.limit?.context;
}

async function renderUsage(usage: RunUsage, _runActive: boolean): Promise<void> {
  if (!panelEl) return;
  const generation = ++renderGeneration;
  // A new snapshot may legitimately have no usage yet. Replace the old run's
  // cached totals before deciding visibility so a completed predecessor can
  // never reappear through the storage fallback.
  lastUsage = usage;
  const visible = usageHasContent(usage);
  panelEl.hidden = !visible;
  if (!visible) return;

  const limit = await contextLimitFor(usage.model);
  // The model lookup is asynchronous. A later snapshot/storage refresh wins;
  // never let this older lookup repaint the newer run's totals.
  if (generation !== renderGeneration || !panelEl) return;
  const latestUsage = {
    tokensIn: usage.lastTokensIn ?? usage.tokensIn,
    tokensOut: usage.lastTokensOut ?? usage.tokensOut,
    reasoningTokens: usage.lastReasoningTokens,
  };
  const pct = contextUsagePct(latestUsage, limit);
  const meterFill = panelEl.querySelector<HTMLElement>("#usageMeterFill");
  if (meterFill) {
    // Compositor-only animation: transform+origin skips layout/paint on the
    // streaming path (CSS transition: transform .3s in the panel styles).
    meterFill.style.transform = `scaleX(${(pct / 100).toFixed(3)})`;
    meterFill.style.transformOrigin = "left";
  }
  const meterValue = panelEl.querySelector<HTMLElement>("#usageMeterValue");
  if (meterValue) meterValue.textContent = limit ? `${pct.toFixed(0)}%` : "—";

  const totals = panelEl.querySelector<HTMLElement>("#usageTotals");
  if (totals) {
    const parts = [
      `${formatTokens(usage.tokensIn)} in`,
      `${formatTokens(completionTokens(usage))} out`,
    ];
    if (usage.reasoningTokens) parts.push(`${formatTokens(usage.reasoningTokens)} reasoning`);
    if (usage.cachedInputTokens || usage.cachedWriteInputTokens) {
      parts.push(`${formatTokens(usage.cachedInputTokens ?? 0)} cache`);
    }
    if (usage.model) parts.push(usage.model);
    if (isUncataloguedModel(usage.model)) parts.push("uncatalogued price");
    totals.textContent = `${parts.join(" · ")} · ${formatUsd(usage.costUsd)}`;
  }
}

/** Render usage carried by the authoritative V1 snapshot. */
export function renderUsageFromSnapshot(usage: RunUsage, runActive: boolean): Promise<void> {
  snapshotDriven = true;
  return renderUsage(usage, runActive);
}

async function refreshFromRunState(): Promise<void> {
  if (snapshotDriven) return;
  let state: RunState | null = null;
  try {
    state = await getRunState();
  } catch {
    state = null;
  }
  if (snapshotDriven) return;
  if (!state) {
    // Run ended (state cleared): keep the last totals visible; if this panel
    // never saw a run, stay hidden.
    if (lastUsage) await renderUsage(lastUsage, false);
    return;
  }
  await renderUsage(state.usage ?? zeroRunUsage(), state.active);
}

function initUsagePanel(): void {
  if (!panelEl) panelEl = createPanel();
  injectStyles();
  const statusBar = document.querySelector<HTMLElement>(".status-bar");
  if (statusBar?.parentElement) {
    statusBar.insertAdjacentElement("afterend", panelEl);
  } else {
    document.body.appendChild(panelEl);
  }
  if (typeof chrome === "undefined" || !chrome.storage?.onChanged) return;
  chrome.storage.onChanged.addListener((changes, _area) => {
    if (RUN_STATE_KEY in changes) void refreshFromRunState();
    if ("provider" in changes || "contextTokens" in changes) {
      cachedProvider = null;
      cachedContextOverride = undefined;
    }
  });
  void refreshFromRunState();
}

subscribeRunView((view) => {
  if (view.snapshot) {
    void renderUsageFromSnapshot(
      view.snapshot.usage ?? zeroRunUsage(),
      view.status === "starting" || view.status === "running" || view.status === "cancelling",
    );
  }
});

/**
 * Prime the model catalog at sidepanel load so the first-paint
 * "uncatalogued price" tag reflects live rates instead of the bundled
 * snapshot. Mirrors the background worker's warmPricingCatalog: kick the
 * pricing refresh (which force-fetches the catalog), then arm the one-shot
 * stale-while-refresh when the live merge landed so a long-lived panel keeps
 * picking up fresh rates. Chrome-less contexts (unit tests) skip the prime —
 * the bundled snapshot stays authoritative there.
 */
function primeCatalogRefresh(): void {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  void import("../../lib/agent/llm/pricing")
    .then((m) => m.refreshPricingFromCatalog())
    .then(async () => {
      const catalog = await import("../../lib/agent/llm/catalog");
      if (catalog.catalogFetchSucceeded()) catalog.scheduleRefresh();
    })
    .catch(() => undefined);
}

initUsagePanel();
primeCatalogRefresh();
