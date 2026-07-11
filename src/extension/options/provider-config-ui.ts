/**
 * options/provider-config-ui.ts — provider metadata + connection-tab UI logic.
 *
 * Owns `redactKeyLeak` (key-leak masking), the provider-change handler that
 * updates the UI, the test-connection button, and the model-search UI.
 *
 * The provider catalog now comes from `./providers` (single source of truth) —
 * this module no longer keeps its own `PROVIDER_META` copy.
 */

import { $, escapeHtml } from "@/extension/shared";
import { PROVIDER_META, DEFAULT_PROVIDER_ID, catalogIdFor } from "./providers";

/**
 * Mask common API-key prefixes that may leak into provider error text before
 * the message is shown in the UI. A provider error string can include the full
 * key (e.g. `401: Invalid API key: sk-ant-api03-...`), which must not be
 * surfaced verbatim. Non-key error text is returned unchanged.
 */
export function redactKeyLeak(s: string): string {
  const KEY_RE = /(sk-ant-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|AIza[A-Za-z0-9_-]+|ya29\.[A-Za-z0-9_-]+|ghp_[A-Za-z0-9_-]+|gho_[A-Za-z0-9_-]+|ghu_[A-Za-z0-9_-]+|ghs_[A-Za-z0-9_-]+|ghr_[A-Za-z0-9_-]+|github_pat_[A-Za-z0-9_-]+|glpat-[A-Za-z0-9_-]+|gsk_[A-Za-z0-9_-]+|xox[baprs]-[A-Za-z0-9_-]+|xai-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+|AKIA[0-9A-Z]{16})/g;
  return s.replace(KEY_RE, (m) => {
    const dash = m.indexOf("-");
    const prefix = dash > 0 ? m.slice(0, dash + 1) : m.slice(0, 4);
    return `${prefix}[REDACTED]`;
  });
}

// ─── Provider config display ───────────────────────────────────────────────

let lastProvider = "";

/**
 * Update the connection-tab UI based on the selected provider. On initial load
 * (lastProvider === ""), only fill if the field is empty (preserving any saved
 * custom URL). On provider change, always replace.
 */
export function updateProviderUI(): void {
  const provider = ($("provider") as HTMLSelectElement).value;
  const meta = PROVIDER_META[provider] || PROVIDER_META[DEFAULT_PROVIDER_ID];
  lastProvider = provider;
  ($("provider-hint") as HTMLElement).textContent = meta.hint;
  const keyInput = $("apiKey") as HTMLInputElement;
  keyInput.placeholder = meta.keyPlaceholder;
  ($("apikey-hint") as HTMLElement).textContent = meta.needsKey
    ? `Get your key at ${meta.keyUrl}`
    : "Local provider — no key required (leave as-is).";
  const modelInput = $("model") as HTMLInputElement;
  if (!modelInput.value) modelInput.placeholder = meta.defaultModel;
  const baseUrlLabel = $("baseurl-label") as HTMLElement;
  const baseUrlInput = $("baseUrl") as HTMLInputElement;
  if (meta.defaultBaseUrl) {
    baseUrlLabel.classList.remove("is-hidden");
    baseUrlInput.placeholder = meta.defaultBaseUrl;
    // Only fill with the catalog default when the field is empty, so a
    // user-set custom baseUrl is preserved across provider switches
    // (previously `isProviderChange` clobbered it with the default).
    if (!baseUrlInput.value) {
      baseUrlInput.value = meta.defaultBaseUrl;
    }
  } else {
    baseUrlLabel.classList.add("is-hidden");
    baseUrlInput.placeholder = "";
    // Leave any user-entered value intact rather than wiping it on switch.
  }
}

// ─── Provider health check ──────────────────────────────────────────────

$("testConnection")?.addEventListener("click", async () => {
  const testBtn = $("testConnection") as HTMLButtonElement;
  const testResult = $("testResult") as HTMLSpanElement;
  testBtn.disabled = true;
  testResult.className = "test-result pending";
  testResult.textContent = "Testing…";

  const provider = ($("provider") as HTMLSelectElement).value;
  // SECURITY: apiKey is read from the form here for a one-shot test. It
  // originates from chrome.storage.local (UNENCRYPTED, MV3 has no secret
  // store). Prefer OAuth where supported; never console.log it. Errors surfaced
  // below go through redactKeyLeak.
  const apiKey = ($("apiKey") as HTMLInputElement).value;
  const model = ($("model") as HTMLInputElement).value;
  const baseUrl = ($("baseUrl") as HTMLInputElement).value;

  if (!provider) {
    testResult.className = "test-result failure";
    testResult.textContent = "✗ No provider selected.";
    testBtn.disabled = false;
    return;
  }

  try {
    const { buildProvider } = await import("../provider-config");
    const providerInstance = await buildProvider({ provider, apiKey, model, baseUrl });
    const start = Date.now();
    const response = await providerInstance.chat({
      messages: [
        { role: "system", content: "Respond with exactly: OK" },
        { role: "user", content: "Say OK" },
      ],
      temperature: 0,
      maxTokens: 5,
    });
    const latency = Date.now() - start;
    const ok = response.content && response.content.length > 0;
    testResult.className = `test-result ${ok ? "success" : "failure"}`;
    testResult.textContent = ok
      ? `✓ Connected (${latency}ms, model: ${response.usage?.model || model})`
      : "✗ Empty response from provider.";
  } catch (e) {
    testResult.className = "test-result failure";
    // Redact BEFORE truncating so a key that appears past the first 100 chars is
    // still masked (previously the slice ran first and leaked it).
    const raw = e instanceof Error ? e.message : String(e);
    testResult.textContent = `✗ ${redactKeyLeak(raw).slice(0, 240)}`;
  } finally {
    testBtn.disabled = false;
  }
});

// ─── Model search (models.dev catalog) ──────────────────────────────────────

let modelSearchTimer: ReturnType<typeof setTimeout> | null = null;

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
$("model")?.addEventListener("input", () => {
  const query = ($("model") as HTMLInputElement).value.trim();
  const resultsDiv = $("model-search-results") as HTMLDivElement;
  if (modelSearchTimer) clearTimeout(modelSearchTimer);
  if (query.length < 2) {
    resultsDiv.classList.add("is-hidden");
    return;
  }
  modelSearchTimer = setTimeout(async () => {
    try {
      const { searchModels, formatCost, formatContext, formatVision } = await import("../../lib/agent/llm/catalog");
      const results = await searchModels(query, 10);
      if (results.length === 0) {
        resultsDiv.classList.add("is-hidden");
        return;
      }
      resultsDiv.innerHTML = "";
      resultsDiv.classList.remove("is-hidden");
      for (const r of results) {
        const item = document.createElement("div");
        item.className = "model-search-result-item";
        const visionTag = formatVision(r.model.attachment);
        item.innerHTML = `<strong>${escapeHtml(r.model.name)}</strong> <span class="provider-name">${escapeHtml(r.providerName)}</span> <span class="meta">${escapeHtml(formatCost(r.model.cost))} · ${escapeHtml(formatContext(r.model.limit))} ctx${visionTag ? " · " + escapeHtml(visionTag) : ""}</span>`;
        item.addEventListener("click", () => {
          ($("model") as HTMLInputElement).value = r.model.id;
          resultsDiv.classList.add("is-hidden");
        });
        resultsDiv.appendChild(item);
      }
    } catch (e) {
      console.warn("[options] model search failed:", e);
      resultsDiv.classList.add("is-hidden");
    }
  }, 300);
});
