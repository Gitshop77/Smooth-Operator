/**
 * options/provider-config-ui.ts — provider metadata + connection-tab UI logic.
 *
 * Owns `PROVIDER_META` (hint/default/needs-key metadata for every supported
 * provider), the provider-change handler that updates the UI, the test-
 * connection button (which builds a one-shot provider instance and pings it),
 * and the model-search UI backed by the models.dev catalog.
 */

import { $, escapeHtml } from "@/extension/shared";

/**
 * Mask common API-key prefixes that may leak into provider error text before
 * the message is shown in the UI. A provider error string can include the full
 * key (e.g. `401: Invalid API key: sk-ant-api03-...`), which must not be
 * surfaced verbatim. Non-key error text is returned unchanged.
 */
function redactKeyLeak(s: string): string {
  const KEY_RE = /(sk-ant-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|AIza[A-Za-z0-9_-]+|gsk_[A-Za-z0-9_-]+|xoxb-[A-Za-z0-9_-]+|xoxp-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+)/g;
  return s.replace(KEY_RE, (m) => {
    const dash = m.indexOf("-");
    const prefix = dash > 0 ? m.slice(0, dash + 1) : m.slice(0, 4);
    return `${prefix}[REDACTED]`;
  });
}

// ─── Provider metadata (hints, defaults, key requirements) ────────────────

interface ProviderMeta {
  /** Hint shown below the provider dropdown. */
  hint: string;
  /** Default model name. */
  defaultModel: string;
  /** Default base URL (for OpenAI-compatible providers). */
  defaultBaseUrl?: string;
  /** Whether this provider requires an API key (local ones don't). */
  needsKey: boolean;
  /** API key placeholder. */
  keyPlaceholder: string;
  /** Where to get an API key. */
  keyUrl: string;
}

export const PROVIDER_META: Record<string, ProviderMeta> = {
  // Local-first: Ollama + OpenCode (free, no key, run on the user's machine).
  ollama:     { hint: "Ollama — local, free. Run `ollama pull <model>` first.", defaultModel: "llama3.3", defaultBaseUrl: "http://localhost:11434/v1", needsKey: false, keyPlaceholder: "ollama", keyUrl: "https://ollama.com" },
  opencode:   { hint: "OpenCode — connect any of 75+ LLM providers via OpenCode.", defaultModel: "", defaultBaseUrl: "https://opencode.ai/api/v1", needsKey: true, keyPlaceholder: "your-opencode-key", keyUrl: "https://opencode.ai/docs/providers" },
  // Native API providers (no base URL needed).
  openai:     { hint: "OpenAI — GPT-4o, o-series, GPT-4.1 models.", defaultModel: "gpt-4o", needsKey: true, keyPlaceholder: "sk-proj-...", keyUrl: "https://platform.openai.com/api-keys" },
  anthropic:  { hint: "Anthropic — Claude 3.5 Sonnet, Opus, Haiku.", defaultModel: "claude-3-5-sonnet", needsKey: true, keyPlaceholder: "sk-ant-api03-...", keyUrl: "https://console.anthropic.com/" },
  gemini:     { hint: "Google Gemini — Pro, Flash, 2.0/2.5 series.", defaultModel: "gemini-2.0-flash", needsKey: true, keyPlaceholder: "AIza...", keyUrl: "https://aistudio.google.com/apikey" },
  // OpenAI-compatible BYO-key providers.
  deepseek:   { hint: "DeepSeek — chat, reasoner (V3, R1).", defaultModel: "deepseek-chat", defaultBaseUrl: "https://api.deepseek.com/v1", needsKey: true, keyPlaceholder: "...", keyUrl: "https://platform.deepseek.com" },
  qwen:       { hint: "Qwen / Alibaba — qwen-2.5-72b, qwen-vl-max.", defaultModel: "qwen-2.5-72b-instruct", defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", needsKey: true, keyPlaceholder: "...", keyUrl: "https://dashscope.aliyuncs.com" },
  groq:       { hint: "Groq — ultra-fast Llama/Mixtral inference.", defaultModel: "llama-3.3-70b-versatile", defaultBaseUrl: "https://api.groq.com/openai/v1", needsKey: true, keyPlaceholder: "gsk_...", keyUrl: "https://console.groq.com" },
  together:   { hint: "Together AI — open-source models.", defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo", defaultBaseUrl: "https://api.together.xyz/v1", needsKey: true, keyPlaceholder: "...", keyUrl: "https://api.together.xyz" },
  mistral:    { hint: "Mistral — Mistral Large, Codestral, Pixtral.", defaultModel: "mistral-large-latest", defaultBaseUrl: "https://api.mistral.ai/v1", needsKey: true, keyPlaceholder: "...", keyUrl: "https://console.mistral.ai" },
  cerebras:   { hint: "Cerebras — ultra-fast inference.", defaultModel: "llama3.1-70b", defaultBaseUrl: "https://api.cerebras.ai/v1", needsKey: true, keyPlaceholder: "...", keyUrl: "https://cerebras.ai" },
  openrouter: { hint: "OpenRouter — 300+ models (provider/model format).", defaultModel: "anthropic/claude-3-5-sonnet", defaultBaseUrl: "https://openrouter.ai/api/v1", needsKey: true, keyPlaceholder: "sk-or-v1-...", keyUrl: "https://openrouter.ai" },
  litellm:    { hint: "LiteLLM — universal proxy.", defaultModel: "gpt-4o", defaultBaseUrl: "http://localhost:4000/v1", needsKey: true, keyPlaceholder: "...", keyUrl: "https://github.com/BerriAI/litellm" },
  azure:      { hint: "Azure OpenAI — use your deployed model name.", defaultModel: "gpt-4o", defaultBaseUrl: "https://your-resource.openai.azure.com", needsKey: true, keyPlaceholder: "...", keyUrl: "https://portal.azure.com" },
};

// ─── Provider config display ───────────────────────────────────────────────

let lastProvider = "";

/** Update the connection-tab UI based on the selected provider.
 *  On initial load (lastProvider === ""), only fill if the field is empty
 *  (preserving any saved custom URL). On provider change, always replace. */
export function updateProviderUI(): void {
  const provider = ($("provider") as HTMLSelectElement).value;
  const meta = PROVIDER_META[provider] || PROVIDER_META.openai;
  const isProviderChange = lastProvider !== "" && lastProvider !== provider;
  lastProvider = provider;
  // Provider hint.
  ($("provider-hint") as HTMLElement).textContent = meta.hint;
  // API key placeholder + hint.
  const keyInput = $("apiKey") as HTMLInputElement;
  keyInput.placeholder = meta.keyPlaceholder;
  ($("apikey-hint") as HTMLElement).textContent = meta.needsKey
    ? `Get your key at ${meta.keyUrl}`
    : "Local provider — no key required (leave as-is).";
  // Model placeholder.
  const modelInput = $("model") as HTMLInputElement;
  if (!modelInput.value) modelInput.placeholder = meta.defaultModel;
  // Show/hide + auto-fill base URL for OpenAI-compatible providers.
  const baseUrlLabel = $("baseurl-label") as HTMLElement;
  const baseUrlInput = $("baseUrl") as HTMLInputElement;
  if (meta.defaultBaseUrl) {
    baseUrlLabel.style.display = "";
    baseUrlInput.placeholder = meta.defaultBaseUrl;
    // Only overwrite the value on provider change, NOT on initial page load
    // (the saved value from storage should be preserved on reload).
    if (isProviderChange || !baseUrlInput.value) {
      baseUrlInput.value = meta.defaultBaseUrl;
    }
  } else {
    baseUrlLabel.style.display = "none";
    if (isProviderChange) baseUrlInput.value = "";
  }
}

$("provider").addEventListener("change", updateProviderUI);

// ─── Provider health check ──────────────────────────────────────────────

$("testConnection").addEventListener("click", async () => {
  const testBtn = $("testConnection") as HTMLButtonElement;
  const testResult = $("testResult") as HTMLSpanElement;
  testBtn.disabled = true;
  testResult.className = "test-result pending";
  testResult.textContent = "Testing…";

  const provider = ($("provider") as HTMLSelectElement).value;
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
    const detail = e instanceof Error ? e.message.slice(0, 100) : String(e);
    testResult.textContent = `✗ ${redactKeyLeak(detail)}`;
  } finally {
    testBtn.disabled = false;
  }
});

// ─── Model search (models.dev catalog) ──────────────────────────────────────

let modelSearchTimer: ReturnType<typeof setTimeout> | null = null;

/** Populate the model datalist + search results from the models.dev catalog. */
async function populateModelSuggestions(): Promise<void> {
  try {
    const { getModelsForProvider, formatCost, formatContext, formatVision } = await import("../../lib/agent/llm/catalog");
    const { CATALOG_PROVIDER_ID_MAP } = await import("../provider-config-map");
    const provider = ($("provider") as HTMLSelectElement).value;

    const catId = CATALOG_PROVIDER_ID_MAP[provider];
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
  } catch {
    // Catalog not available — datalist stays empty, user types manually
  }
}

/** Show search results when the user types in the model field. */
($("model") as HTMLInputElement).addEventListener("input", () => {
  const query = ($("model") as HTMLInputElement).value.trim();
  const resultsDiv = $("model-search-results") as HTMLDivElement;
  // Clear any pending search BEFORE the early-return. Without this, a user
  // who types "gp" (timer set) then backspaces to "g" (< 2 chars) would
  // early-return here, leaving the stale "gp" timer to fire 300ms later and
  // reopen the results div for an input that no longer matches.
  if (modelSearchTimer) clearTimeout(modelSearchTimer);
  if (query.length < 2) {
    resultsDiv.style.display = "none";
    return;
  }
  modelSearchTimer = setTimeout(async () => {
    try {
      const { searchModels, formatCost, formatContext, formatVision } = await import("../../lib/agent/llm/catalog");
      const results = await searchModels(query, 10);
      if (results.length === 0) {
        resultsDiv.style.display = "none";
        return;
      }
      resultsDiv.innerHTML = "";
      resultsDiv.style.display = "block";
      for (const r of results) {
        const item = document.createElement("div");
        item.className = "model-search-result-item";
        // escapeHtml on third-party catalog data (model.name,
        // providerName) to prevent DOM-XSS if the models.dev catalog is
        // compromised/MITM'd. formatCost/formatContext/formatVision return
        // controlled strings so they don't need escaping.
        const visionTag = formatVision(r.model.attachment);
        item.innerHTML = `<strong>${escapeHtml(r.model.name)}</strong> <span class="provider-name">${escapeHtml(r.providerName)}</span> <span class="meta">${escapeHtml(formatCost(r.model.cost))} · ${escapeHtml(formatContext(r.model.limit))} ctx${visionTag ? " · " + visionTag : ""}</span>`;
        item.addEventListener("click", () => {
          ($("model") as HTMLInputElement).value = r.model.id;
          resultsDiv.style.display = "none";
        });
        resultsDiv.appendChild(item);
      }
    } catch {
      resultsDiv.style.display = "none";
    }
  }, 300);
});

// Populate model suggestions when the provider changes
$("provider").addEventListener("change", () => void populateModelSuggestions());
