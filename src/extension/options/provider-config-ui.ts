/**
 * options/provider-config-ui.ts — provider metadata + connection-tab UI logic.
 *
 * Reuses the shared `redactKeyLeak` primitive (from `@/extension/shared`) for
 * the test-connection path, and owns the provider-change handler that updates
 * the UI, the test-connection button, and the model-search UI.
 *
 * The provider catalog now comes from `./providers` (single source of truth) —
 * this module no longer keeps its own `PROVIDER_META` copy.
 */

import { $, redactKeyLeak } from "@/extension/shared";
import { announce } from "../accessibility";
import { PROVIDER_META, DEFAULT_PROVIDER_ID, catalogIdFor } from "./providers";
import { STORAGE_KEYS } from "./storage-keys";
import { testSelectedModelConnection, type ConnectionTestResult } from "./connection-test";
import { providerConfigStore, connectionDiagnosticsStore } from "./stores";
import {
  fetchCatalog,
  getProviders,
  getModelsForProvider,
  searchModels,
  formatCost,
  formatContext,
  formatVision,
  reasoningOptionsFor,
} from "@/lib/agent/llm/catalog";
import type { ReasoningOption, ReasoningEffort } from "@/lib/agent/llm/catalog-data";
import {
  refreshPricingFromCatalog,
  getLastPricingError,
} from "@/lib/agent/llm/pricing";
import {
  updateOpencodeEndpointHint,
  applyDefaultModelPlaceholder,
  renderModelResultItem,
  emptyModelSearchHtml,
  reasoningEffortOptions,
  budgetTokensOption,
} from "./provider-config-ui-utils";

// Re-export the shared secret-masking primitive so callers (and tests) that
// previously imported it from this module keep working after the move to
// `@/extension/shared` (single source of truth).
export { redactKeyLeak };

// ─── Provider config display ───────────────────────────────────────────────

let lastProvider = "";

// One-time warning when readProviderConfig fell back from an unrecognized
// provider to the default. The flag is written by readProviderConfig and
// consumed (cleared) here on first render.
if (typeof chrome !== "undefined" && chrome.storage?.local) {
  void chrome.storage.local.get([STORAGE_KEYS.providerResetWarning]).then((res) => {
    if (res?.[STORAGE_KEYS.providerResetWarning]) {
      void chrome.storage.local.remove(STORAGE_KEYS.providerResetWarning);
      const sel = document.getElementById("provider") as HTMLSelectElement | null;
      const host = sel?.parentElement ?? document.body;
      const el = document.createElement("div");
      el.className = "qp-field-error";
      el.setAttribute("role", "alert");
      el.textContent = "Your provider was reset to OpenAI because the stored value was unrecognized. Re-select your provider in Options.";
      host.appendChild(el);
      setTimeout(() => el.remove(), 6000);
    }
  });
}

/**
 * Update the connection-tab UI based on the selected provider. The default
 * baseUrl is shown as a *placeholder* only. On a genuine provider change the
 * field is reset to the new provider's default; on initial load we preserve
 * whatever was loaded from storage — including an intentionally-cleared (empty)
 * baseUrl, which should fall back to the provider's built-in endpoint rather
 * than be silently replaced by the default here.
 */
export function updateProviderUI(): void {
  // Non-throwing getter: invoked at module-load time by settings-sync's
  // import-time load callback, which may run with a partial DOM in tests.
  const sel = document.getElementById("provider") as HTMLSelectElement | null;
  if (!sel) return;
  const provider = sel.value;
  const meta = PROVIDER_META[provider] || PROVIDER_META[DEFAULT_PROVIDER_ID];
 // A *real* provider change (vs. the initial call) is what may carry a stale
 // baseUrl from the previous provider. Track the last provider so we can tell
 // the two apart instead of clobbering a user's custom URL on first paint.
  const providerChanged = lastProvider !== "" && lastProvider !== provider;
  lastProvider = provider;
  const providerHint = document.getElementById("provider-hint");
  if (providerHint) providerHint.textContent = meta.hint;
  const keyInput = document.getElementById("apiKey") as HTMLInputElement | null;
  if (keyInput) keyInput.placeholder = meta.keyPlaceholder;
  const apikeyHint = document.getElementById("apikey-hint");
  if (apikeyHint) {
    apikeyHint.textContent = meta.needsKey
      ? `Get your key at ${meta.keyUrl}. Held in memory for this session unless you opt into encrypted storage on this device below.`
      : "Local provider — no key required. Leave this blank.";
  }
  const modelInput = document.getElementById("model") as HTMLInputElement | null;
  if (modelInput && !modelInput.value) applyDefaultModelPlaceholder();
  const baseUrlLabel = document.getElementById("baseurl-label");
  const baseUrlInput = document.getElementById("baseUrl") as HTMLInputElement | null;
  if (meta.defaultBaseUrl) {
    baseUrlLabel?.classList.remove("is-hidden");
    if (baseUrlInput) baseUrlInput.placeholder = meta.defaultBaseUrl;
    if (providerChanged && baseUrlInput) {
      baseUrlInput.value = meta.defaultBaseUrl;
    }
  } else {
    baseUrlLabel?.classList.add("is-hidden");
    if (baseUrlInput) baseUrlInput.placeholder = "";
 // Providers without a default have no canonical endpoint — clear any
 // leftover value from a previous provider so it isn't sent by mistake.
    if (providerChanged && baseUrlInput) baseUrlInput.value = "";
  }

 // The Azure resource name is only relevant to Azure OpenAI. Show it only for
 // that provider; preserve any stored value otherwise (use providerChanged to
 // avoid clobbering a saved value on first paint, mirroring baseUrl above).
  const resourceNameLabel = document.getElementById("resourcename-label");
  const resourceNameInput = document.getElementById("resourceName") as HTMLInputElement | null;
  if (provider === "azure") {
    resourceNameLabel?.classList.remove("is-hidden");
  } else {
    resourceNameLabel?.classList.add("is-hidden");
    if (providerChanged && resourceNameInput) resourceNameInput.value = "";
  }

 // OpenCode Zen / Go: show dynamic endpoint hint based on model type.
 // These providers use different API paths per model family, so the user
 // must set the base URL to match their chosen model.
  const endpointHint = document.getElementById("opencode-endpoint-hint");
  if (endpointHint) {
    if (provider === "opencode") {
      endpointHint.classList.remove("is-hidden");
      updateOpencodeEndpointHint("zen");
    } else if (provider === "opencode-go") {
      endpointHint.classList.remove("is-hidden");
      updateOpencodeEndpointHint("go");
    } else {
      endpointHint.classList.add("is-hidden");
    }
  }

  // O1: re-render the reasoning section for the current provider/model. Keeps
  // the effort list + budget range in sync when the provider changes.
  populateReasoningControls();
}

/**
 * Render the reasoning (O1) section for the selected provider/model. The
 * effort levels come from the model's `reasoning_options` intersected with the
 * safe low/medium/high set; the thinking-budget field appears only for models
 * that declare a token range. Explicit args override DOM reads so callers can
 * render for a freshly-committed model id. Non-throwing: a partial DOM (tests)
 * simply leaves the section untouched.
 */
export function populateReasoningControls(modelId?: string, providerId?: string): void {
  const effortSel = document.getElementById("reasoningEffort") as HTMLSelectElement | null;
  const budgetLabel = document.getElementById("reasoning-budget-label") as HTMLElement | null;
  const budgetInput = document.getElementById("reasoningBudget") as HTMLInputElement | null;
  if (!effortSel) return;

  const provider = providerId ??
    (document.getElementById("provider") as HTMLSelectElement | null)?.value ?? "";
  const model = (modelId ?? (document.getElementById("model") as HTMLInputElement | null)?.value ?? "")
    .trim();
  const catId = catalogIdFor(provider);
  const options: ReasoningOption[] = catId ? reasoningOptionsFor(model, catId) : [];
  const efforts = reasoningEffortOptions(options);
  const budget = budgetTokensOption(options);

  // Preserve the current selection when it stays valid; otherwise reset to the
  // first supported level so the form never carries an option that vanished.
  const current = effortSel.value;
  effortSel.innerHTML = "";
  for (const v of efforts) {
    const opt = document.createElement("option");
    // `ReasoningEffort` includes literal `null` ("disable reasoning"); the
    // safe-set intersection above never emits it, but the type allows it.
    opt.value = v ?? "";
    opt.textContent = v ?? "";
    effortSel.appendChild(opt);
  }
  const fallbackEffort = efforts[0] ?? "medium";
  effortSel.value = efforts.includes(current as ReasoningEffort) ? current : fallbackEffort;

  if (budgetLabel && budgetInput) {
    if (budget) {
      budgetLabel.classList.remove("is-hidden");
      if (budget.min !== undefined) budgetInput.min = String(budget.min);
      if (budget.max !== undefined) budgetInput.max = String(budget.max);
      // Nudge an out-of-range stored value back into the model's range.
      const v = Number(budgetInput.value);
      if (budgetInput.value !== "" && !Number.isNaN(v)) {
        const clamped = Math.max(
          budget.min ?? -Infinity,
          Math.min(budget.max ?? Infinity, v),
        );
        budgetInput.value = String(clamped);
      }
    } else {
      budgetLabel.classList.add("is-hidden");
      budgetInput.removeAttribute("min");
      budgetInput.removeAttribute("max");
    }
  }
}

// ─── Provider health check ──────────────────────────────────────────────

/**
 * Render the diagnostic surface strictly from the connection-diagnostics
 * store. The store is authoritative: button disabled/aria-busy, result text,
 * and class all derive from the current diagnostic entry, so a stale response
 * dropped by the generation guard also cannot corrupt the UI.
 */
export function renderDiagnosticsFromStore(): void {
  const testBtn = document.getElementById("testConnection") as HTMLButtonElement | null;
  const testResult = document.getElementById("testResult") as HTMLSpanElement | null;
  if (!testBtn || !testResult) return;
  testResult.setAttribute("aria-live", "polite");
  const { current, error } = connectionDiagnosticsStore.getState();
  const pending = current.state === "pending";
  testBtn.disabled = pending;
  testBtn.setAttribute("aria-busy", String(pending));
  switch (current.state) {
    case "idle":
      testResult.className = "test-result";
      testResult.textContent = error ?? "";
      break;
    case "pending":
      testResult.className = "test-result pending";
      testResult.textContent = "Testing…";
      break;
    case "ok":
      testResult.className = "test-result success";
      testResult.textContent = `✓ ${current.result?.message ?? "Connected"}`;
      break;
    case "cancelled":
      testResult.className = "test-result failure";
      testResult.textContent = "✗ Cancelled";
      announce("Connection test cancelled", { assertive: true });
      break;
    case "failed":
      testResult.className = "test-result failure";
      testResult.textContent = `✗ ${current.error ?? "Connection test failed"}`;
      announce(`Connection test failed: ${current.error ?? "Connection test failed"}`, {
        assertive: true,
      });
      break;
  }
}

document.getElementById("testConnection")?.addEventListener("click", async () => {
  const provider = ($("provider") as HTMLSelectElement).value;
  const baseUrl = ($("baseUrl") as HTMLInputElement).value;
  const model = ($("model") as HTMLInputElement).value.trim();
  // `resourceName` is only present for Azure; read it without the throwing `$`
  // helper so a missing field degrades to "" rather than crashing the handler.
  const resourceNameEl = document.getElementById("resourceName") as HTMLInputElement | null;
  const resourceName = resourceNameEl?.value ?? "";
  // Blank is meaningful for a local endpoint: the background can query
  // `/v1/models` and auto-select when the server exposes exactly one model.
  const effectiveModel = model || (provider === "ollama" ? "" : PROVIDER_META[provider]?.defaultModel || "");
  const contextTokensRaw = (document.getElementById("contextTokens") as HTMLInputElement | null)?.value ?? "";
  const parsedContextTokens = Number(contextTokensRaw);
  const contextTokens = Number.isSafeInteger(parsedContextTokens) && parsedContextTokens > 0
    ? parsedContextTokens
    : undefined;

  if (!provider) {
    connectionDiagnosticsStore.dispatch({ type: "DIAGNOSTICS_ERROR", error: "No provider selected." });
    renderDiagnosticsFromStore();
    return;
  }

  // Tag this test with the CURRENT selection generation. If the user changes
  // provider/model while the request is in flight, DIAGNOSTICS_INVALIDATED
  // bumps the generation and this late response is dropped on resolve.
  const generation = connectionDiagnosticsStore.getState().current.generation;
  connectionDiagnosticsStore.dispatch({
    type: "DIAGNOSTICS_TEST_STARTED",
    generation,
    provider,
    model: effectiveModel,
  });
  renderDiagnosticsFromStore();

  try {
    const result: ConnectionTestResult = await testSelectedModelConnection({
      provider,
      model: effectiveModel,
      baseUrl: baseUrl || undefined,
      resourceName: resourceName || undefined,
      provenance: "user",
      ...(contextTokens ? { contextTokens } : {}),
    });
    if (result.ok && !model && result.model) {
      const modelInput = document.getElementById("model") as HTMLInputElement | null;
      if (modelInput) {
        modelInput.value = result.model;
        modelInput.dispatchEvent(new Event("input", { bubbles: true }));
        modelInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    if (result.ok && result.contextTokens) {
      const contextInput = document.getElementById("contextTokens") as HTMLInputElement | null;
      // `/props` is authoritative for llama.cpp. Auto-fill a blank field but
      // preserve an explicit user cap (for example, intentionally using less
      // than the server's maximum context).
      if (contextInput && !contextInput.value.trim()) {
        contextInput.value = String(result.contextTokens);
        contextInput.dispatchEvent(new Event("input", { bubbles: true }));
        contextInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    // The generation guard decides whether this result is still current; the
    // render pass below always reflects the store's (possibly dropped) state.
    connectionDiagnosticsStore.dispatch({
      type: "DIAGNOSTICS_TEST_RESOLVED",
      generation,
      result: {
        version: 1,
        ok: result.ok,
        code: result.ok ? "ok" : "provider_error",
        latencyMs: result.latencyMs,
        provider,
        model: result.model || effectiveModel,
        message: result.message,
      },
    });
  } catch (e) {
    // Defensive: testProviderConnection normally never throws (it returns a result
    // object), but if something unexpected escapes we still redact + truncate.
    const masked = redactKeyLeak(e instanceof Error ? e.message : String(e));
    connectionDiagnosticsStore.dispatch({
      type: "DIAGNOSTICS_TEST_FAILED",
      generation,
      error: masked.slice(0, 240),
    });
  }
  renderDiagnosticsFromStore();
});

// ─── Model search (models.dev catalog) ──────────────────────────────────────

let modelSearchTimer: ReturnType<typeof setTimeout> | null = null;
// Monotonic token identifying the latest scheduled search. When an earlier
// search's async `searchModels` promise resolves after a newer keystroke has
// already fired, we discard the stale result so the dropdown only ever shows
// matches for the CURRENT text-box contents.
let modelSearchToken = 0;
// Active index for keyboard navigation of model search results (ArrowUp/Down).
let activeResultIdx = -1;

/** Populate the model datalist from the models.dev catalog. */
export async function populateModelSuggestions(): Promise<void> {
  try {
    const provider = ($("provider") as HTMLSelectElement).value;
    const catId = catalogIdFor(provider);
    if (catId) {
      const models = await getModelsForProvider(catId);
      const datalist = $("model-suggestions") as HTMLDataListElement;
      datalist.innerHTML = "";
      for (const m of models.slice(0, 50)) {
        const opt = document.createElement("option");
        opt.value = m.id;
        const visionTag = formatVision(m.attachment);
        opt.label = `${m.name} · ${formatCost(m.cost)} · ${formatContext(m.limit)}${visionTag ? " · " + visionTag : ""}`;
        datalist.appendChild(opt);
      }
    }
  } catch (e) {
 // Catalog not available — datalist stays empty, user types manually
    console.warn("[options] model suggestions failed:", e);
  }
}

/** Show search results when the user types in the model field. */
document.getElementById("model")?.addEventListener("input", () => {
  const query = ($("model") as HTMLInputElement).value.trim();
  const resultsDiv = document.getElementById("model-search-results") as HTMLDivElement | null;
  if (!resultsDiv) return;
 // L13: expose the search results as a listbox so assistive tech can
 // announce + navigate them. The input owns the popup via aria-owns and
 // reflects open state via aria-expanded.
  resultsDiv.setAttribute("role", "listbox");
  resultsDiv.setAttribute("aria-label", "Model search results");
  const modelInput = $("model") as HTMLInputElement;
  modelInput.setAttribute("aria-controls", "model-search-results");
  const provider = ($("provider") as HTMLSelectElement).value;
  if (provider === "opencode" || provider === "opencode-go") {
    updateOpencodeEndpointHint(provider === "opencode" ? "zen" : "go");
  }
  if (modelSearchTimer) clearTimeout(modelSearchTimer);
 // Refresh the placeholder when the field is emptied so it shows the current
 // provider's default model (the two concerns now live in one listener).
  if (query.length === 0) {
    applyDefaultModelPlaceholder();
  }
  if (query.length < 2) {
    resultsDiv.classList.add("is-hidden");
    modelInput.setAttribute("aria-expanded", "false");
    modelInput.removeAttribute("aria-activedescendant");
    activeResultIdx = -1;
    return;
  }
  const myToken = ++modelSearchToken;
  activeResultIdx = -1;
  // Show loading state while searching
  resultsDiv.innerHTML = `<div class="model-search-loading">Searching\u2026</div>`;
  resultsDiv.classList.remove("is-hidden");
  modelInput.setAttribute("aria-expanded", "true");
  modelSearchTimer = setTimeout(async () => {
    try {
      const results = await searchModels(query, 10);
 // A newer keystroke has superseded this search — drop the stale result.
      if (myToken !== modelSearchToken) return;
      if (results.length === 0) {
        resultsDiv.innerHTML = emptyModelSearchHtml(provider, query);
        resultsDiv.classList.remove("is-hidden");
        modelInput.setAttribute("aria-expanded", "true");
        modelInput.removeAttribute("aria-activedescendant");
        activeResultIdx = -1;
        return;
      }
      resultsDiv.innerHTML = "";
      resultsDiv.classList.remove("is-hidden");
      modelInput.setAttribute("aria-expanded", "true");

      const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const searchRe = new RegExp(`(${escapedQuery})`, "gi");

      // Group results by provider
      const grouped = new Map<string, typeof results>();
      for (const r of results) {
        const key = r.providerName;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(r);
      }

      let optIdx = 0;

      for (const [providerName, models] of grouped) {
        // Provider section header
        const header = document.createElement("div");
        header.className = "model-search-group-header";
        header.textContent = `${providerName} \u00b7 ${models.length} model${models.length > 1 ? "s" : ""}`;
        resultsDiv.appendChild(header);

        for (const r of models) {
          resultsDiv.appendChild(
            renderModelResultItem(r.model, r.providerName, modelInput, optIdx++, {
              cost: formatCost,
              context: formatContext,
              vision: formatVision,
            }, searchRe),
          );
        }
      }

      const firstItem = resultsDiv.querySelector<HTMLDivElement>(".model-search-result-item");
      if (firstItem) {
        activeResultIdx = 0;
        modelInput.setAttribute("aria-activedescendant", firstItem.id);
        firstItem.setAttribute("aria-selected", "true");
      }
    } catch (e) {
      console.warn("[options] model search failed:", e);
      resultsDiv.classList.add("is-hidden");
    }
  }, 150);
});

// ─── Delegated click handler for model search results ───────────────────────

/** Remove any stale experimental-model notice. */
function clearExperimentalModelNotice(): void {
  document.querySelectorAll(".experimental-notice").forEach((n) => n.remove());
}

/**
 * Show a confirmation notice when an alpha/beta (experimental) model is
 * explicitly committed. Experimental releases can change or disappear without
 * notice, so the options UI surfaces that at selection time; the notice is
 * replaced on the next commit. `role=alert` so assistive tech announces it.
 */
function showExperimentalModelNotice(modelId: string, status: "alpha" | "beta"): void {
  clearExperimentalModelNotice();
  const modelInput = $("model") as HTMLInputElement;
  const notice = document.createElement("div");
  notice.className = "experimental-notice";
  notice.setAttribute("role", "alert");
  notice.textContent =
    `Model "${modelId}" is an ${status} (experimental) release — ` +
    `it may change or disappear without notice.`;
  modelInput.insertAdjacentElement("afterend", notice);
}

document.getElementById("model-search-results")?.addEventListener("click", (e) => {
  const target = (e.target as HTMLElement).closest<HTMLDivElement>(".model-search-result-item");
  if (!target?.dataset.modelId) return;
  const modelInput = $("model") as HTMLInputElement;
  modelInput.value = target.dataset.modelId;
  modelInput.dispatchEvent(new Event("input", { bubbles: true }));
  modelInput.setAttribute("aria-activedescendant", target.id);
  modelInput.setAttribute("aria-expanded", "false");
  const resultsDiv = $("model-search-results") as HTMLDivElement;
  resultsDiv.classList.add("is-hidden");
  const status = target.dataset.status;
  if (status === "alpha" || status === "beta") {
    showExperimentalModelNotice(target.dataset.modelId, status);
  } else {
    clearExperimentalModelNotice();
  }
  // O1: a committed model may carry different reasoning options than the
  // previous one — refresh the reasoning section for it.
  populateReasoningControls(target.dataset.modelId);
  // Commit the selection to the authoritative store: the reducer bumps the
  // generation so any in-flight connection test for the previous model is
  // dropped on resolve (no stale-cache leak across model changes).
  providerConfigStore.dispatch({ type: "MODEL_SELECTED", model: target.dataset.modelId });
});

// ─── Keyboard navigation for model search results ──────────────────────────

document.getElementById("model")?.addEventListener("keydown", (e) => {
  const resultsDiv = document.getElementById("model-search-results") as HTMLDivElement | null;
  if (!resultsDiv || resultsDiv.classList.contains("is-hidden")) return;
  const items = Array.from(resultsDiv.querySelectorAll<HTMLDivElement>(".model-search-result-item"));
  if (items.length === 0) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    activeResultIdx = Math.min(activeResultIdx + 1, items.length - 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    activeResultIdx = Math.max(activeResultIdx - 1, 0);
  } else if (e.key === "Escape") {
    resultsDiv.classList.add("is-hidden");
    ($("model") as HTMLInputElement).setAttribute("aria-expanded", "false");
    activeResultIdx = -1;
    return;
  } else if (e.key === "Enter" && activeResultIdx >= 0) {
    e.preventDefault();
    items[activeResultIdx].click();
    return;
  } else {
    return;
  }
  items.forEach((el, i) => el.setAttribute("aria-selected", String(i === activeResultIdx)));
  ($("model") as HTMLInputElement).setAttribute("aria-activedescendant", items[activeResultIdx].id);
});

// Outside-click dismiss for model search dropdown
document.addEventListener("mousedown", (e) => {
  const resultsDiv = document.getElementById("model-search-results") as HTMLDivElement | null;
  const modelInput = document.getElementById("model") as HTMLInputElement | null;
  if (!resultsDiv || resultsDiv.classList.contains("is-hidden")) return;
  if (!modelInput) return;
  if (
    !resultsDiv.contains(e.target as Node) &&
    e.target !== modelInput
  ) {
    resultsDiv.classList.add("is-hidden");
    modelInput.setAttribute("aria-expanded", "false");
    modelInput.removeAttribute("aria-activedescendant");
    activeResultIdx = -1;
  }
});

// ─── Refresh models from models.dev ────────────────────────────────────────

/**
 * Force a re-fetch of the live models.dev catalog and re-populate the model
 * picker from the freshly-merged cache. Non-throwing: on any failure (offline,
 * API error, shape-validation failure) we keep the existing (bundled) models in
 * place and surface a warning instead of crashing the Options UI.
 *
 * Wired with the non-throwing `document.getElementById(id)?.addEventListener`
 * pattern so a partial DOM (e.g. in tests) never throws at module load.
 */
document.getElementById("refreshModels")?.addEventListener("click", async () => {
  const btn = document.getElementById("refreshModels") as HTMLButtonElement | null;
  const status = document.getElementById("refreshModelsStatus") as HTMLSpanElement | null;
  if (!btn) return;

  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  if (status) {
    status.className = "test-result pending";
    status.textContent = "Refreshing…";
  }

  // `baseText`/`baseClass` capture the model-catalog refresh result so the
  // pricing-health line (below) can be appended to the SAME status area without
  // clobbering the existing model-refresh messaging.
  let baseText = "⚠ Could not reach models.dev — using bundled catalog";
  let baseClass = "test-result failure";
  try {
    await fetchCatalog(true);
    const total = getProviders().reduce(
      (n, p) => n + Object.keys(getModelsForProvider(p.id)).length,
      0,
    );
    // Re-populate the model datalist from the freshly-merged catalog (the same
    // render the Options UI normally runs on load / provider change).
    await populateModelSuggestions();
    baseText = `✓ Loaded ${total} models from models.dev`;
    baseClass = "test-result success";
  } catch (e) {
    // Defensive: fetchCatalog is internally non-throwing (falls back to the
    // bundled snapshot), but if anything unexpected escapes we still degrade
    // gracefully and leave the existing models in place.
    console.warn("[options] refresh models failed:", e);
  }

  // R2 §6: also refresh live pricing and report its health on the SAME line.
  // refreshPricingFromCatalog is internally non-throwing (records its failure
  // via lastPricingError), so we read getLastPricingError() to label the result.
  await refreshPricingFromCatalog();
  const pricingErr = getLastPricingError();
  if (status) {
    status.className = baseClass;
    status.textContent = `${baseText} · pricing: ${pricingErr ? pricingErr.message : "OK"}`;
  }

  btn.disabled = false;
  btn.setAttribute("aria-busy", "false");
});

// ─── Diagnostics invalidation + rendering (store wiring) ───────────

/**
 * Whenever the authoritative provider/model selection changes, the diagnostic
 * surface is invalidated (its generation advances) so an in-flight connection
 * test for the previous selection cannot settle onto the new one. Rendering
 * then happens strictly from the store.
 */
let lastSelectionKey = "";
providerConfigStore.subscribe((state) => {
  const key = `${state.provider}|${state.model}`;
  if (key !== lastSelectionKey) {
    lastSelectionKey = key;
    connectionDiagnosticsStore.dispatch({ type: "DIAGNOSTICS_INVALIDATED" });
  }
  renderDiagnosticsFromStore();
});

// Initial render so the surface reflects the store before any user action.
renderDiagnosticsFromStore();
