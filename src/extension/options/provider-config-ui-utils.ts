import { escapeHtml } from "@/extension/shared";
import { PROVIDER_META, DEFAULT_PROVIDER_ID } from "./providers";
import type { CatalogModel } from "../../lib/agent/llm/catalog";

/**
 * OpenCode Zen/Go endpoint hint — the server routes all model families through
 * /chat/completions, so the client always uses the same path regardless of
 * model type. This function shows the full endpoint as a hint and auto-fills
 * the baseUrl field with the API BASE only: the runtime facade appends
 * /chat/completions itself, so committing the suffixed endpoint here would
 * produce a doubled path (…/chat/completions/chat/completions) and a 404.
 */
export function updateOpencodeEndpointHint(tier: "zen" | "go"): void {
  const endpointHint = document.getElementById("opencode-endpoint-hint");
  const baseUrlInput = document.getElementById("baseUrl") as HTMLInputElement | null;
  if (!endpointHint || !baseUrlInput) return;

  const base = tier === "zen" ? "https://opencode.ai/zen/v1" : "https://opencode.ai/zen/go/v1";
  const endpoint = `${base}/chat/completions`;
  endpointHint.innerHTML = `Server routes all models via <code>${escapeHtml(endpoint)}</code>`;
  // Auto-fill the baseUrl field if empty.
  if (!baseUrlInput.value) {
    baseUrlInput.value = base;
  }
}

/** Reset the model field's placeholder to the current provider's default model. */
export function applyDefaultModelPlaceholder(): void {
  const providerEl = document.getElementById("provider") as HTMLSelectElement | null;
  if (!providerEl) return;
  const provider = providerEl.value;
  const meta = PROVIDER_META[provider] || PROVIDER_META[DEFAULT_PROVIDER_ID];
  const modelEl = document.getElementById("model") as HTMLInputElement | null;
  if (meta?.defaultModel && modelEl) modelEl.placeholder = meta.defaultModel;
}

/**
 * Highlight matched text in search results.
 *
 * The query regex is built from raw user input, but the display text is
 * HTML-escaped before interpolation into innerHTML. Applying the regex to the
 * escaped text would never match queries containing `&` or `<` (they become
 * `&amp;` / `&lt;`) and could split an entity like `&amp;`. Match against the
 * RAW text, escape each segment separately, then wrap matched spans in
 * `<mark>` — the output stays escaped end-to-end.
 */
function highlightMatch(text: string, searchRe: RegExp | null): string {
  if (!searchRe) return escapeHtml(text);
  const re = searchRe.global ? searchRe : new RegExp(searchRe.source, `${searchRe.flags}g`);
  let out = "";
  let last = 0;
  for (const m of text.matchAll(re)) {
    out += escapeHtml(text.slice(last, m.index));
    out += `<mark class="model-highlight">${escapeHtml(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  out += escapeHtml(text.slice(last));
  return out;
}

/**
 * Build one model-search result row: a listbox `option` showing the model name,
 * its exact catalog `id` (the real provider id committed on click — this is what
 * removes the OpenRouter-style `claude-3-5-sonnet` hyphen/dot ambiguity), the
 * provider it belongs to, plus pricing (`formatCost`), context (`formatContext`)
 * and a Vision tag (`formatVision`). Returns the element; the caller appends it.
 */
export function renderModelResultItem(
  model: CatalogModel,
  providerName: string,
  modelInput: HTMLInputElement,
  optIdx: number,
  fmt: {
    cost: (c: CatalogModel["cost"]) => string;
    context: (l: CatalogModel["limit"]) => string;
    vision: (a?: boolean) => string;
  },
  searchRe: RegExp | null,
): HTMLDivElement {
  const item = document.createElement("div");
  item.className = "model-search-result-item";
  item.tabIndex = -1;
  // L13: each result is a listbox option with a stable id so the input's
  // aria-activedescendant can point at the focused/hovered one.
  item.setAttribute("role", "option");
  item.id = `model-search-opt-${optIdx}`;
  item.setAttribute("aria-label", `Select model ${model.name} from ${providerName}`);
  item.dataset.modelId = model.id;
  item.addEventListener("mouseenter", () => {
    modelInput.setAttribute("aria-activedescendant", item.id);
  });
  const visionTag = fmt.vision(model.attachment);
  item.innerHTML =
    `<div class="result-primary">` +
      `<strong>${highlightMatch(model.name, searchRe)}</strong> ` +
      `<span class="provider-name">${escapeHtml(providerName)}</span> ` +
      (visionTag ? `<span class="vision-tag">${escapeHtml(visionTag)}</span>` : "") +
    `</div>` +
    `<div class="result-secondary">` +
      `<code class="model-id">${escapeHtml(model.id)}</code> ` +
      `<span class="meta">${escapeHtml(fmt.cost(model.cost))} · ${escapeHtml(fmt.context(model.limit))} ctx</span>` +
    `</div>`;
  const currentValue = modelInput.value.trim();
  if (currentValue && model.id === currentValue) {
    item.classList.add("is-selected");
  }
  return item;
}
