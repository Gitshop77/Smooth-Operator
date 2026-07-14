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
 *
 * The allowlist is derived from the provider catalog (`PROVIDER_META`) so a new
 * or custom provider's key prefix is covered automatically (finding:
 * redactKeyLeak was a fixed allowlist not derived from PROVIDERS, so new/custom
 * provider keys could leak). Well-known global prefixes that aren't tied to a
 * single catalog entry (GitHub PATs, JWTs, AWS, Slack, GitLab, generic `sk-` /
 * `sk-ant-`) are kept as a base set.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Base key patterns not derivable from a single catalog placeholder. */
const BASE_KEY_PATTERNS = [
  "sk-ant-[A-Za-z0-9_-]+",
  "sk-[A-Za-z0-9_-]+",
  "AIza[A-Za-z0-9_-]+",
  "ya29\\.[A-Za-z0-9_-]+",
  "ghp_[A-Za-z0-9_-]+",
  "gho_[A-Za-z0-9_-]+",
  "ghu_[A-Za-z0-9_-]+",
  "ghs_[A-Za-z0-9_-]+",
  "ghr_[A-Za-z0-9_-]+",
  "github_pat_[A-Za-z0-9_-]+",
  "glpat-[A-Za-z0-9_-]+",
  "gsk_[A-Za-z0-9_-]+",
  "xoxb-[A-Za-z0-9_-]+",
  "xoxp-[A-Za-z0-9_-]+",
  "xoxa-[A-Za-z0-9_-]+",
  "xoxs-[A-Za-z0-9_-]+",
  "AKIA[0-9A-Z]{16}",
 // JWT: mask the ENTIRE token (header.payload.signature), not just the header.
  "eyJ[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*",
];

/** Derive concrete key prefixes from provider placeholders (e.g. `sk-ant-api03-...` → `sk-ant-`). */
function providerKeyPrefixes(): string[] {
  const out = new Set<string>();
  for (const p of Object.values(PROVIDER_META)) {
    const ph = p.keyPlaceholder;
    if (!ph || ph === "...") continue;
    const m = /^[A-Za-z0-9_-]+/.exec(ph);
    if (!m) continue;
    const prefix = m[0];
 // Skip obviously non-secret placeholders (provider labels, not keys).
    if (prefix === "ollama" || prefix === "your-opencode-key") continue;
    out.add(escapeRegex(prefix) + "[A-Za-z0-9_-]+");
  }
  return [...out];
}

const KEY_RE = new RegExp("(" + [...providerKeyPrefixes(), ...BASE_KEY_PATTERNS].join("|") + ")", "g");

export function redactKeyLeak(s: string): string {
  KEY_RE.lastIndex = 0;
  return s.replace(KEY_RE, (m) => {
    const dash = m.indexOf("-");
    const prefix = dash > 0 ? m.slice(0, dash + 1) : m.slice(0, 4);
    return `${prefix}[REDACTED]`;
  });
}

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
$("model")?.addEventListener("input", () => {
  const query = ($("model") as HTMLInputElement).value.trim();
  const resultsDiv = $("model-search-results") as HTMLDivElement;
  if (modelSearchTimer) clearTimeout(modelSearchTimer);
 // Refresh the placeholder when the field is emptied so it shows the current
 // provider's default model (the two concerns now live in one listener).
  if (query.length === 0) {
    applyDefaultModelPlaceholder();
  }
  if (query.length < 2) {
    resultsDiv.classList.add("is-hidden");
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
        return;
      }
      resultsDiv.innerHTML = "";
      resultsDiv.classList.remove("is-hidden");
      for (const r of results) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "model-search-result-item";
        item.setAttribute("aria-label", `Select model ${r.model.name} from ${r.providerName}`);
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
