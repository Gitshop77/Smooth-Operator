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

import { $, escapeHtml } from "@/extension/shared";
import { PROVIDER_META, DEFAULT_PROVIDER_ID, catalogIdFor } from "./providers";
import { testProviderConnection, type ConnectionTestResult } from "./connection-test";
import type { CatalogModel } from "../../lib/agent/llm/catalog";

// Re-export the shared secret-masking primitive so callers (and tests) that
// previously imported it from this module keep working after the move to
// `@/extension/shared` (single source of truth).
export { redactKeyLeak } from "@/extension/shared";

// ─── Provider config display ───────────────────────────────────────────────

let lastProvider = "";

/** Reset the model field's placeholder to the current provider's default model. */
function applyDefaultModelPlaceholder(): void {
  const provider = ($("provider") as HTMLSelectElement).value;
  const meta = PROVIDER_META[provider] || PROVIDER_META[DEFAULT_PROVIDER_ID];
  if (meta?.defaultModel) ($("model") as HTMLInputElement).placeholder = meta.defaultModel;
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
  const provider = ($("provider") as HTMLSelectElement).value;
  const meta = PROVIDER_META[provider] || PROVIDER_META[DEFAULT_PROVIDER_ID];
 // A *real* provider change (vs. the initial call) is what may carry a stale
 // baseUrl from the previous provider. Track the last provider so we can tell
 // the two apart instead of clobbering a user's custom URL on first paint.
  const providerChanged = lastProvider !== "" && lastProvider !== provider;
  lastProvider = provider;
  ($("provider-hint") as HTMLElement).textContent = meta.hint;
  const keyInput = $("apiKey") as HTMLInputElement;
  keyInput.placeholder = meta.keyPlaceholder;
  ($("apikey-hint") as HTMLElement).textContent = meta.needsKey
    ? `Get your key at ${meta.keyUrl}`
    : "Local provider — no key required (leave as-is).";
  const modelInput = $("model") as HTMLInputElement;
  if (!modelInput.value) applyDefaultModelPlaceholder();
  const baseUrlLabel = $("baseurl-label") as HTMLElement;
  const baseUrlInput = $("baseUrl") as HTMLInputElement;
  if (meta.defaultBaseUrl) {
    baseUrlLabel.classList.remove("is-hidden");
    baseUrlInput.placeholder = meta.defaultBaseUrl;
 // Only overwrite the field on a genuine provider change. On initial load
 // we must preserve whatever was loaded from storage — including an
 // intentionally-cleared (empty) baseUrl, which should fall back to the
 // provider's built-in endpoint rather than be silently replaced by the
 // default here (finding: updateProviderUI overwrote an empty saved baseUrl
 // with the provider default on load).
    if (providerChanged) {
      baseUrlInput.value = meta.defaultBaseUrl;
    }
  } else {
    baseUrlLabel.classList.add("is-hidden");
    baseUrlInput.placeholder = "";
 // Providers without a default have no canonical endpoint — clear any
 // leftover value from a previous provider so it isn't sent by mistake.
    if (providerChanged) baseUrlInput.value = "";
  }

 // The Azure resource name is only relevant to Azure OpenAI. Show it only for
 // that provider; preserve any stored value otherwise (use providerChanged to
 // avoid clobbering a saved value on first paint, mirroring baseUrl above).
  const resourceNameLabel = $("resourcename-label") as HTMLElement;
  const resourceNameInput = $("resourceName") as HTMLInputElement;
  if (provider === "azure") {
    resourceNameLabel.classList.remove("is-hidden");
  } else {
    resourceNameLabel.classList.add("is-hidden");
    if (providerChanged) resourceNameInput.value = "";
  }
}

// ─── Provider health check ──────────────────────────────────────────────

$("testConnection")?.addEventListener("click", async () => {
  const testBtn = $("testConnection") as HTMLButtonElement;
  const testResult = $("testResult") as HTMLSpanElement;
  testResult.setAttribute("aria-live", "polite");
  testBtn.disabled = true;
  testBtn.setAttribute("aria-busy", "true");
  testResult.className = "test-result pending";
  testResult.textContent = "Testing…";

  const provider = ($("provider") as HTMLSelectElement).value;
 // SECURITY: apiKey is read from the form here for a one-shot test. It
 // originates from chrome.storage.local (UNENCRYPTED, MV3 has no secret
 // store). Prefer OAuth where supported; never console.log it. Errors surfaced
 // below are redacted inside `testProviderConnection` (reuses `redactKeyLeak`).
  const apiKey = ($("apiKey") as HTMLInputElement).value;
 // The model field is no longer needed for the test — `testProviderConnection`
 // validates connectivity via the provider's models-list endpoint, not a chat
 // completion. We still read it (prefixed `_`) so the placeholder logic stays
 // coherent and the value isn't lost if the user later re-runs a chat-based path.
  const _model = ($("model") as HTMLInputElement).value;
  const baseUrl = ($("baseUrl") as HTMLInputElement).value;
 // `resourceName` is only present for Azure; read it without the throwing `$`
 // helper so a missing field degrades to "" rather than crashing the handler.
  const resourceNameEl = document.getElementById("resourceName") as HTMLInputElement | null;
  const resourceName = resourceNameEl?.value ?? "";

  if (!provider) {
    testResult.className = "test-result failure";
    testResult.textContent = "✗ No provider selected.";
    testBtn.disabled = false;
    testBtn.setAttribute("aria-busy", "false");
    return;
  }

  try {
    const result: ConnectionTestResult = await testProviderConnection({
      provider,
      apiKey,
      baseUrl: baseUrl || undefined,
      resourceName: resourceName || undefined,
    });
    testResult.className = `test-result ${result.ok ? "success" : "failure"}`;
    testResult.textContent = result.ok
      ? `✓ ${result.message}`
      : `✗ ${result.message}`;
  } catch (e) {
 // Defensive: testProviderConnection normally never throws (it returns a result
 // object), but if something unexpected escapes we still redact + truncate.
    testResult.className = "test-result failure";
    const raw = e instanceof Error ? e.message : String(e);
    let masked = raw;
    if (apiKey && apiKey.length >= 8) masked = masked.split(apiKey).join("[REDACTED]");
    testResult.textContent = `✗ ${masked.slice(0, 240)}`;
  } finally {
    testBtn.disabled = false;
    testBtn.setAttribute("aria-busy", "false");
  }
});

// ─── Model search (models.dev catalog) ──────────────────────────────────────

let modelSearchTimer: ReturnType<typeof setTimeout> | null = null;
// Monotonic token identifying the latest scheduled search. When an earlier
// search's async `searchModels` promise resolves after a newer keystroke has
// already fired, we discard the stale result so the dropdown only ever shows
// matches for the CURRENT text-box contents.
let modelSearchToken = 0;

/** Populate the model datalist from the models.dev catalog. */
export async function populateModelSuggestions(): Promise<void> {
  try {
    const { getModelsForProvider, formatCost, formatContext, formatVision } = await import("../../lib/agent/llm/catalog");
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
/**
 * Build one model-search result row: a listbox `option` showing the model name,
 * its exact catalog `id` (the real provider id committed on click — this is what
 * removes the OpenRouter-style `claude-3-5-sonnet` hyphen/dot ambiguity), the
 * provider it belongs to, plus pricing (`formatCost`), context (`formatContext`)
 * and a Vision tag (`formatVision`). Returns the element; the caller appends it.
 */
function renderModelResultItem(
  model: CatalogModel,
  providerName: string,
  modelInput: HTMLInputElement,
  resultsDiv: HTMLDivElement,
  optIdx: number,
  fmt: {
    cost: (c: CatalogModel["cost"]) => string;
    context: (l: CatalogModel["limit"]) => string;
    vision: (a?: boolean) => string;
  },
): HTMLButtonElement {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "model-search-result-item";
  // L13: each result is a listbox option with a stable id so the input's
  // aria-activedescendant can point at the focused/hovered one.
  item.setAttribute("role", "option");
  item.id = `model-search-opt-${optIdx}`;
  item.setAttribute("aria-label", `Select model ${model.name} from ${providerName}`);
  item.addEventListener("mouseenter", () => {
    modelInput.setAttribute("aria-activedescendant", item.id);
  });
  const visionTag = fmt.vision(model.attachment);
  item.innerHTML =
    `<strong>${escapeHtml(model.name)}</strong> ` +
    `<span class="provider-name">${escapeHtml(providerName)}</span> ` +
    `<code class="model-id">${escapeHtml(model.id)}</code> ` +
    `<span class="meta">${escapeHtml(fmt.cost(model.cost))} · ${escapeHtml(fmt.context(model.limit))} ctx${visionTag ? " · " + escapeHtml(visionTag) : ""}</span>`;
  item.addEventListener("click", () => {
    // Commit the real provider model id (NOT the display name).
    ($("model") as HTMLInputElement).value = model.id;
    modelInput.setAttribute("aria-activedescendant", item.id);
    modelInput.setAttribute("aria-expanded", "false");
    resultsDiv.classList.add("is-hidden");
  });
  return item;
}

/** Show search results when the user types in the model field. */
$("model")?.addEventListener("input", () => {
  const query = ($("model") as HTMLInputElement).value.trim();
  const resultsDiv = $("model-search-results") as HTMLDivElement;
 // L13: expose the search results as a listbox so assistive tech can
 // announce + navigate them. The input owns the popup via aria-owns and
 // reflects open state via aria-expanded.
  resultsDiv.setAttribute("role", "listbox");
  resultsDiv.setAttribute("aria-label", "Model search results");
  const modelInput = $("model") as HTMLInputElement;
  modelInput.setAttribute("aria-owns", "model-search-results");
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
    return;
  }
  const myToken = ++modelSearchToken;
  modelSearchTimer = setTimeout(async () => {
    try {
      const { searchModels, formatCost, formatContext, formatVision } = await import("../../lib/agent/llm/catalog");
      const results = await searchModels(query, 10);
 // A newer keystroke has superseded this search — drop the stale result.
      if (myToken !== modelSearchToken) return;
      if (results.length === 0) {
        resultsDiv.classList.add("is-hidden");
        modelInput.setAttribute("aria-expanded", "false");
        modelInput.removeAttribute("aria-activedescendant");
        return;
      }
      resultsDiv.innerHTML = "";
      resultsDiv.classList.remove("is-hidden");
      modelInput.setAttribute("aria-expanded", "true");
      let optIdx = 0;
      for (const r of results) {
        resultsDiv.appendChild(
          renderModelResultItem(r.model, r.providerName, modelInput, resultsDiv, optIdx++, {
            cost: formatCost,
            context: formatContext,
            vision: formatVision,
          }),
        );
      }
    } catch (e) {
      console.warn("[options] model search failed:", e);
      resultsDiv.classList.add("is-hidden");
    }
  }, 300);
});
