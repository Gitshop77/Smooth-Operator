/**
 * provider error text may embed an API key — `redactKeyLeak` must mask
 * the common key prefixes before the message is surfaced in the UI.
 *
 * `provider-config-ui.ts` runs DOM side-effects at import time (it wires up
 * event listeners on specific element ids), so we set up those elements before
 * the dynamic import.
 */

import { describe, test, expect, beforeAll, afterEach, vi } from "vitest";
import type { CatalogModel } from "../src/lib/agent/llm/catalog";
import type { ReasoningOption } from "../src/lib/agent/llm/catalog";
import {
  emptyModelSearchHtml,
  renderModelResultItem,
} from "../src/extension/options/provider-config-ui-utils";
import { makeChromeStorageMock } from "./helpers/chrome-storage-mock";
import {
  reasoningEffortOptions,
  budgetTokensOption,
} from "../src/extension/options/provider-config-ui-utils";

function setupDom(): void {
  const localStore = new Map<string, unknown>();
  const sessionStore = new Map<string, unknown>();
  modelPersistenceStores = { local: localStore, session: sessionStore };
  (globalThis as unknown as { chrome: unknown }).chrome = makeChromeStorageMock(
    localStore,
    sessionStore,
  );

  document.body.innerHTML = `
    <select id="provider"></select>
    <button id="testConnection"></button>
    <input id="model">
    <div id="model-search-results"></div>
    <span id="provider-hint"></span>
    <input id="apiKey">
    <input type="checkbox" id="rememberApiKey">
    <span id="apikey-hint"></span>
    <label id="baseurl-label"></label>
    <input id="baseUrl">
    <input id="resourceName">
    <input id="maxSteps">
    <input id="maxActions">
    <input id="plannerInterval">
    <input id="maxFailures">
    <input id="costCap">
    <textarea id="defaultTask"></textarea>
    <input id="screenshotQuality">
    <input id="screenshotImageTokens">
    <input id="screenshotMaxDimension">
    <input id="screenshotMaxBytes">
    <input type="checkbox" id="enableScreenshots">
    <input type="checkbox" id="enableStealth">
    <textarea id="allowedDomains"></textarea>
    <textarea id="blockedDomains"></textarea>
    <input type="checkbox" id="notifyOnCompletion">
    <input type="checkbox" id="notifyOnError">
    <input type="checkbox" id="notifyOnTakeover">
    <input id="webhookUrl">
    <input type="radio" name="visionMode" value="disabled" checked>
    <select id="agentMode"><option value="standard">standard</option></select>
    <select id="reasoningEffort"></select>
    <input id="reasoningBudget">
    <label id="reasoning-budget-label" class="is-hidden"></label>
    <select id="forceReasoning"><option value="auto">auto</option></select>
    <div id="saved"></div>
  `;
}

let modelPersistenceStores: {
  local: Map<string, unknown>;
  session: Map<string, unknown>;
};

/** Minimal CatalogModel fixture — only the fields renderModelResultItem reads. */
function makeModel(over: Partial<CatalogModel>): CatalogModel {
  return {
    id: "gpt-5.6",
    name: "GPT-5.6",
    release_date: "2026-07-09",
    attachment: false,
    reasoning: true,
    tool_call: true,
    ...over,
  } as CatalogModel;
}

describe("custom/local model search empty state", () => {
  test("tells Ollama users an uncatalogued server model id remains valid", () => {
    const html = emptyModelSearchHtml("ollama", "org/Qwen-local:Q4");
    expect(html).toContain("will be used as typed");
    expect(html).toContain("org&#47;Qwen-local:Q4");
    expect(html).not.toContain("No models match");
  });

  test("escapes a custom model id before rendering it", () => {
    const html = emptyModelSearchHtml("ollama", "<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
  });
});

describe("redactKeyLeak", () => {
  let redactKeyLeak: (s: string) => string;

  beforeAll(async () => {
    setupDom();
    const mod = await import("../src/extension/options/provider-config-ui");
    redactKeyLeak = mod.redactKeyLeak;
  });

  test("masks a sk- key", () => {
    expect(redactKeyLeak("401: Invalid API key: sk-proj-abc123")).toBe(
      "401: Invalid API key: sk-[REDACTED]",
    );
  });

  test("masks a sk-ant- key", () => {
    const redacted = redactKeyLeak("error: sk-ant-api03-xyz789");
 // The implementation masks at the first '-', so `sk-ant-api03-xyz789`
 // collapses to `sk-[REDACTED]` — the random secret body is gone.
    expect(redacted).toContain("sk-[REDACTED]");
    expect(redacted).not.toContain("sk-ant-api03-xyz789");
    expect(redacted).not.toContain("api03-xyz789");
  });

  test("masks an AIza (Google) key", () => {
    const redacted = redactKeyLeak("AIzaSyABC123DEF");
    expect(redacted).toContain("AIza[REDACTED]");
    expect(redacted).not.toContain("AIzaSyABC123DEF");
  });

  test("masks a gsk_ (Groq) key", () => {
    const redacted = redactKeyLeak("gsk_abcdefghijklmnop");
    expect(redacted).toContain("gsk_[REDACTED]");
    expect(redacted).not.toContain("abcdefghijklmnop");
  });

  test("masks an xoxb- (Slack) key", () => {
    const redacted = redactKeyLeak("xoxb-1234567890-abcdef");
    expect(redacted).toContain("xoxb-[REDACTED]");
    expect(redacted).not.toContain("1234567890-abcdef");
  });

  test("masks a JWT (eyJ...) key", () => {
    const redacted = redactKeyLeak("token: eyJhbGciOiJIUzI1NiJ9.abc");
 // The regex stops at the JWT's first '.', so the leading `eyJh` segment is
 // masked; the full token must not survive.
    expect(redacted).toContain("eyJh[REDACTED]");
    expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  test("leaves non-key error text unchanged", () => {
    expect(redactKeyLeak("Network timeout after 30000ms")).toBe("Network timeout after 30000ms");
  });

  test("does not leak the key body even when embedded mid-string", () => {
    const redacted = redactKeyLeak("curl failed: sk-live-abcdefghijklmnopqr");
    expect(redacted).toContain("sk-[REDACTED]");
    expect(redacted).not.toContain("abcdefghijklmnopqr");
  });

  test("is idempotent (re-masking an already-redacted string is a no-op)", () => {
    const once = redactKeyLeak("401: Invalid API key: sk-proj-abc123");
    expect(redactKeyLeak(once)).toBe(once);
  });

  test("masks two different secrets in one string", () => {
    const redacted = redactKeyLeak("401: sk-proj-abc123 and gsk_xyz789");
    expect(redacted).toBe("401: sk-[REDACTED] and gsk_[REDACTED]");
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("xyz789");
  });
});

/**
 * O4 — alpha/beta (experimental) gating in the options UI. Experimental models
 * are excluded from default resolution (catalog tests) and, when explicitly
 * picked, carry an "experimental" badge in search results plus a confirmation
 * notice on commit.
 *
 * The module's event listeners are wired at FIRST import (in the
 * redactKeyLeak suite's beforeAll against the extended DOM), so these tests
 * reuse that same DOM + cached module instance — re-running setupDom here
 * would replace the elements the listeners are bound to.
 */
describe("experimental model badge + confirmation", () => {
  beforeAll(async () => {
    // Loading the module wires the delegated listeners against the DOM set up
    // in the redactKeyLeak suite's beforeAll (which runs first).
    await import("../src/extension/options/provider-config-ui");
  });

  function commitModel(modelId: string, status: string): void {
    const resultsDiv = document.getElementById("model-search-results") as HTMLDivElement;
    const item = document.createElement("div");
    item.className = "model-search-result-item";
    item.dataset.modelId = modelId;
    item.dataset.status = status;
    resultsDiv.appendChild(item);
    item.click();
    item.remove();
  }

  function fmt() {
    return {
      cost: () => "$0.00",
      context: () => "200k",
      vision: () => "",
    };
  }

  test("search results render an experimental badge for alpha models", () => {
    const input = document.createElement("input");
    const item = renderModelResultItem(
      makeModel({ id: "moonshotai/Kimi-K2.6-Fast", name: "Kimi K2.6 Fast", status: "alpha" }),
      "Inceptron",
      input,
      0,
      fmt(),
      null,
    );
    const tag = item.querySelector(".experimental-tag");
    expect(tag).not.toBeNull();
    expect(tag?.textContent).toBe("alpha");
  });

  test("search results render an experimental badge for beta models", () => {
    const input = document.createElement("input");
    const item = renderModelResultItem(
      makeModel({ id: "gemini-3.5-flash", name: "Gemini 3.5 Flash", status: "beta" }),
      "Google",
      input,
      0,
      fmt(),
      null,
    );
    const tag = item.querySelector(".experimental-tag");
    expect(tag).not.toBeNull();
    expect(tag?.textContent).toBe("beta");
  });

  test("stable models render no experimental badge", () => {
    const input = document.createElement("input");
    const item = renderModelResultItem(makeModel({ id: "gpt-5.6", name: "GPT-5.6" }), "OpenAI", input, 0, fmt(), null);
    expect(item.querySelector(".experimental-tag")).toBeNull();
  });

  test("committing an alpha model renders the experimental confirmation notice", () => {
    commitModel("moonshotai/Kimi-K2.6-Fast", "alpha");
    const notice = document.querySelector(".experimental-notice");
    expect(notice).not.toBeNull();
    expect(notice?.getAttribute("role")).toBe("alert");
    expect(notice?.textContent).toContain("experimental");
    expect(notice?.textContent).toContain("alpha");
  });

  test("committing a beta model renders the experimental confirmation notice", () => {
    commitModel("gemini-3.5-flash", "beta");
    const notice = document.querySelector(".experimental-notice");
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain("beta");
  });

  test("committing a stable model clears any experimental notice", () => {
    commitModel("moonshotai/Kimi-K2.6-Fast", "alpha");
    expect(document.querySelector(".experimental-notice")).not.toBeNull();
    commitModel("gpt-5.6", "");
    expect(document.querySelector(".experimental-notice")).toBeNull();
  });
});

/**
 * Characterization for the model-persistence defect recorded in the
 * modernization plan. These tests follow the Options runtime path through
 * `settings-sync.initAutoSave()` and `saveSettings()` to the mocked
 * `chrome.storage.local` persistence boundary. Typing persists both the flat
 * model mirror and the active provider's nested model, but result commits
 * Commits a selected result through the same bubbling input boundary,
 * so click and keyboard selection are ordinary persistence regressions.
 */
describe("Model selection persistence characterization", () => {
  beforeAll(async () => {
    const { initAutoSave } = await import("../src/extension/options/settings-sync");
    initAutoSave();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function resetPersistenceBoundary(): void {
    modelPersistenceStores.local.clear();
    modelPersistenceStores.session.clear();
  }

  function expectModelAtPersistenceBoundary(modelId: string): void {
    expect(modelPersistenceStores.local.get("model")).toBe(modelId);
    const providerId = (document.getElementById("provider") as HTMLSelectElement).value;
    const providerConfigs = modelPersistenceStores.local.get("providerConfigs") as
      | Record<string, { model?: unknown }>
      | undefined;
    expect(providerConfigs?.[providerId]?.model).toBe(modelId);
  }

  test("typing a model name reaches the debounced autosave boundary", async () => {
    vi.useFakeTimers();
    resetPersistenceBoundary();
    const input = document.getElementById("model") as HTMLInputElement;
    input.value = "typed-model";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    await vi.advanceTimersByTimeAsync(300);
    expectModelAtPersistenceBoundary("typed-model");
  });

  test("choosing a result by click updates the visible model value", () => {
    const input = document.getElementById("model") as HTMLInputElement;
    const results = document.getElementById("model-search-results") as HTMLDivElement;
    const item = document.createElement("div");
    item.className = "model-search-result-item";
    item.dataset.modelId = "click-value-selected-model";
    results.appendChild(item);

    item.click();

    expect(input.value).toBe("click-value-selected-model");
    item.remove();
  });

  test("choosing the active result with Enter updates the visible model value", () => {
    const input = document.getElementById("model") as HTMLInputElement;
    const results = document.getElementById("model-search-results") as HTMLDivElement;
    results.classList.remove("is-hidden");
    const item = document.createElement("div");
    item.className = "model-search-result-item";
    item.dataset.modelId = "keyboard-value-selected-model";
    results.appendChild(item);

    input.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowDown", bubbles: true, cancelable: true,
    }));
    input.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", bubbles: true, cancelable: true,
    }));

    expect(input.value).toBe("keyboard-value-selected-model");
    item.remove();
  });

  test("choosing a result by click persists the selected model", async () => {
    vi.useFakeTimers();
    resetPersistenceBoundary();
    const input = document.getElementById("model") as HTMLInputElement;
    const results = document.getElementById("model-search-results") as HTMLDivElement;

    const item = document.createElement("div");
    item.className = "model-search-result-item";
    item.dataset.modelId = "click-selected-model";
    results.appendChild(item);
    item.click();

    expect(input.value).toBe("click-selected-model");
    await vi.advanceTimersByTimeAsync(300);
    expectModelAtPersistenceBoundary("click-selected-model");
  });

  test("choosing the active result with Enter persists the selected model", async () => {
    vi.useFakeTimers();
    resetPersistenceBoundary();
    const input = document.getElementById("model") as HTMLInputElement;
    const results = document.getElementById("model-search-results") as HTMLDivElement;

    results.classList.remove("is-hidden");
    const item = document.createElement("div");
    item.className = "model-search-result-item";
    item.dataset.modelId = "keyboard-selected-model";
    results.appendChild(item);
    input.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowDown", bubbles: true, cancelable: true,
    }));
    input.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", bubbles: true, cancelable: true,
    }));

    expect(input.value).toBe("keyboard-selected-model");
    await vi.advanceTimersByTimeAsync(300);
    expectModelAtPersistenceBoundary("keyboard-selected-model");
  });
});

/**
 * O1 UI — reasoning variant helpers. The effort list is derived from the
 * model's `reasoning_options` (O7 accessor) but intersected with the
 * widely-supported safe set (low/medium/high) so the UI never offers a level
 * the runtime will drop or that can 400 on a pre-cutoff model.
 */
describe("reasoning variant helpers (O1 UI)", () => {
  test("effort list is filtered to the widely-supported safe set", () => {
    const opts: ReasoningOption[] = [
      { type: "effort", values: ["none", "low", "medium", "high", "xhigh"] },
    ];
    expect(reasoningEffortOptions(opts)).toEqual(["low", "medium", "high"]);
  });

  test("effort list preserves the model's subset when it excludes a default level", () => {
    const opts: ReasoningOption[] = [{ type: "effort", values: ["low", "high"] }];
    expect(reasoningEffortOptions(opts)).toEqual(["low", "high"]);
  });

  test("no effort option → default low/medium/high fallback", () => {
    expect(reasoningEffortOptions([])).toEqual(["low", "medium", "high"]);
    expect(reasoningEffortOptions([{ type: "toggle" }])).toEqual(["low", "medium", "high"]);
    expect(reasoningEffortOptions([{ type: "budget_tokens", min: 1024 }])).toEqual([
      "low", "medium", "high",
    ]);
  });

  test("budget option is surfaced with its token range", () => {
    const opts: ReasoningOption[] = [
      { type: "toggle" },
      { type: "budget_tokens", min: 1024, max: 63999 },
    ];
    expect(budgetTokensOption(opts)).toEqual({ min: 1024, max: 63999 });
  });

  test("no budget option → undefined", () => {
    expect(budgetTokensOption([{ type: "effort", values: ["low", "high"] }])).toBeUndefined();
    expect(budgetTokensOption([])).toBeUndefined();
  });
});

/**
 * O1 UI — the reasoning section render is catalog-driven (reuses the same
 * cached module instance + DOM as the suites above).
 */
describe("reasoning controls (O1 UI) — catalog-driven render", () => {
  let populateReasoningControls: (
    modelId?: string,
    providerId?: string,
  ) => void;

  beforeAll(async () => {
    const mod = await import("../src/extension/options/provider-config-ui");
    populateReasoningControls = mod.populateReasoningControls;
  });

  function selectOptions(selId: string): string[] {
    const sel = document.getElementById(selId) as HTMLSelectElement;
    return Array.from(sel.options).map((o) => o.value);
  }

  test("gpt-5.4 (openai) renders its safe effort levels, no budget field", () => {
    populateReasoningControls("gpt-5.4", "openai");
    expect(selectOptions("reasoningEffort")).toEqual(["low", "medium", "high"]);
    expect(
      document.getElementById("reasoning-budget-label")?.classList.contains("is-hidden"),
    ).toBe(true);
  });

  test("claude-opus-4-5 (302ai) shows the thinking-budget field with its range", () => {
    populateReasoningControls("claude-opus-4-5", "302ai");
    expect(
      document.getElementById("reasoning-budget-label")?.classList.contains("is-hidden"),
    ).toBe(false);
    const budget = document.getElementById("reasoningBudget") as HTMLInputElement;
    expect(budget.min).toBe("1024");
    expect(budget.max).toBe("63999");
  });

  test("unknown/empty model falls back to low/medium/high and hides the budget field", () => {
    populateReasoningControls("totally-unknown-model-xyz", "openai");
    expect(selectOptions("reasoningEffort")).toEqual(["low", "medium", "high"]);
    expect(
      document.getElementById("reasoning-budget-label")?.classList.contains("is-hidden"),
    ).toBe(true);
  });
});
