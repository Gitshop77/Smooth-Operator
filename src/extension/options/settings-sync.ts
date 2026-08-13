/**
 * options/settings-sync.ts — load/save settings + secrets.
 * Helpers extracted to settings-sync-utils.ts; keys in storage-keys.ts.
 */

import { $ } from "@/extension/shared";
import { syncRememberedApiKey } from "@/extension/api-key-storage";
import { announce } from "../accessibility";
import { updateProviderUI } from "./provider-config-ui";
import { PROVIDER_META, DEFAULT_PROVIDER_ID } from "./providers";
import { alertModal } from "./modal";
import { validateWebhookUrl, resolveAndValidateWebhookUrl } from "@/lib/agent/llm/route/ssrf";
import { clampWebhookUrl } from "@/lib/agent/retention";
import type { SsrfCheckResult } from "@/lib/agent/llm/route/ssrf-constants";
import { MAX_ACTIONS, DEFAULT_MAX_ACTIONS } from "@/lib/validations";
import {
  readInt, isHttpUrl, isHostname, setVal, setChecked, parseDomains,
  populateProviderSelect, showSaved, initAutoSave as initAutoSaveImpl,
  migrateSecretsFromLocalToSession, renderSecrets, composeSettingsSaveSummary,
} from "./settings-sync-utils";
import { STORAGE_KEYS } from "./storage-keys";
import { providerConfigStore, settingsSyncStore } from "./stores";

export { readInt, isHttpUrl, isHostname, showSaved, renderSecrets };

// Last successfully-persisted webhook URL. On a transient DNS failure the field
// keeps the typed URL but the previous good value is what gets persisted, so
// the configured webhook never silently disappears (mirrors notifications.ts).
// Declared before the load block below, which seeds it from storage.
let lastKnownGoodWebhookUrl = "";

populateProviderSelect();

// ─── Load settings ─────────────────────────────────────────────────────────

if (typeof chrome !== "undefined" && chrome.storage?.local) {
  settingsSyncStore.dispatch({ type: "SETTINGS_LOAD_START" });
  chrome.storage.local.get(
    [
      STORAGE_KEYS.provider, STORAGE_KEYS.apiKey, STORAGE_KEYS.rememberApiKey,
      STORAGE_KEYS.model,
      STORAGE_KEYS.baseUrl, STORAGE_KEYS.resourceName, STORAGE_KEYS.maxSteps,
      STORAGE_KEYS.maxActions, STORAGE_KEYS.plannerInterval,
      STORAGE_KEYS.maxFailures, STORAGE_KEYS.costCap, STORAGE_KEYS.defaultTask,
      STORAGE_KEYS.screenshotQuality, STORAGE_KEYS.enableScreenshots, STORAGE_KEYS.stealthEnabled,
      STORAGE_KEYS.enableLocalVision, STORAGE_KEYS.visionMode, STORAGE_KEYS.allowedDomains, STORAGE_KEYS.blockedDomains,
      STORAGE_KEYS.notifyOnCompletion, STORAGE_KEYS.notifyOnError,
      STORAGE_KEYS.notifyOnTakeover, STORAGE_KEYS.webhookUrl, STORAGE_KEYS.agentMode,
      STORAGE_KEYS.reasoningEffort, STORAGE_KEYS.reasoningBudget, STORAGE_KEYS.forceReasoning,
      STORAGE_KEYS.contextTokens,
      STORAGE_KEYS.providerConfigs,
    ],
    (res) => {
      if (chrome.runtime.lastError) {
        console.warn("[options] storage.get failed:", chrome.runtime.lastError);
        settingsSyncStore.dispatch({
          type: "SETTINGS_LOAD_FAIL",
          error: chrome.runtime.lastError.message || "Settings could not be loaded.",
        });
        return;
      }
      const sel = document.getElementById("provider") as HTMLSelectElement | null;
      if (!sel) return;
      const savedProvider = (res.provider as string) ?? DEFAULT_PROVIDER_ID;
      if (!PROVIDER_META[savedProvider]) {
        const opt = document.createElement("option");
        opt.value = savedProvider;
        opt.textContent = savedProvider;
        sel.appendChild(opt);
      }
      sel.value = savedProvider;

      if (typeof chrome !== "undefined" && chrome.storage?.session) {
        chrome.storage.session.get([STORAGE_KEYS.apiKey], (sres) => {
          if (chrome.runtime.lastError) {
            setVal("apiKey", (res.apiKey as string) ?? "");
            return;
          }
          const sessionKey = (sres[STORAGE_KEYS.apiKey] as string) ?? "";
          setVal("apiKey", sessionKey || ((res.apiKey as string) ?? ""));
        });
      } else {
        setVal("apiKey", (res.apiKey as string) ?? "");
      }

      setChecked("rememberApiKey", res[STORAGE_KEYS.rememberApiKey] === true);

      const textFields: Array<[string, string, string]> = [
        ["model", STORAGE_KEYS.model, ""], ["baseUrl", STORAGE_KEYS.baseUrl, ""],
        ["resourceName", STORAGE_KEYS.resourceName, ""], ["agentMode", STORAGE_KEYS.agentMode, "standard"],
        ["defaultTask", STORAGE_KEYS.defaultTask, ""], ["webhookUrl", STORAGE_KEYS.webhookUrl, ""],
      ];
      for (const [elId, key, def] of textFields) setVal(elId, (res[key] as string) ?? def);

      const numFields: Array<[string, string, number]> = [
        ["maxSteps", STORAGE_KEYS.maxSteps, 100], ["maxActions", STORAGE_KEYS.maxActions, 10],
        ["plannerInterval", STORAGE_KEYS.plannerInterval, 5], ["maxFailures", STORAGE_KEYS.maxFailures, 5],
      ];
      for (const [elId, key, def] of numFields) setVal(elId, String(res[key] ?? def));

      // Optional model-context override (tokens). llm-direct reads this to
      // derive per-kind prompt budgets for models whose catalog `limit.context`
      // differs from what the user can actually run (e.g. a 256k native model
      // capped at 64k locally). Empty → no override.
      const ctxEl = document.getElementById("contextTokens") as HTMLInputElement | null;
      if (ctxEl) {
        setVal("contextTokens", res[STORAGE_KEYS.contextTokens] != null ? String(res[STORAGE_KEYS.contextTokens]) : "");
      }

      const costCap = typeof res[STORAGE_KEYS.costCap] === "number" ? Math.max(0, res[STORAGE_KEYS.costCap] as number) : 0;
      setVal("costCap", String(costCap));
      setVal("screenshotQuality", String(res[STORAGE_KEYS.screenshotQuality] ?? 80));
      setChecked("enableScreenshots", res[STORAGE_KEYS.enableScreenshots] !== false);
      setChecked("enableStealth", res[STORAGE_KEYS.stealthEnabled] !== false);

      const visionMode = (res[STORAGE_KEYS.visionMode] as string) || (res[STORAGE_KEYS.enableLocalVision] === true ? "always" : "disabled");
      const visionRadio = Array.from(
        document.querySelectorAll<HTMLInputElement>('input[name="visionMode"]'),
      ).find((r) => r.value === visionMode) ?? null;
      if (visionRadio) visionRadio.checked = true;

      const toLines = (v: unknown) => Array.isArray(v) ? (v as string[]).join("\n") : "";
      setVal("allowedDomains", toLines(res[STORAGE_KEYS.allowedDomains]));
      setVal("blockedDomains", toLines(res[STORAGE_KEYS.blockedDomains]));
      setChecked("notifyOnCompletion", (res[STORAGE_KEYS.notifyOnCompletion] as boolean) || false);
      setChecked("notifyOnError", (res[STORAGE_KEYS.notifyOnError] as boolean) || false);
      setChecked("notifyOnTakeover", (res[STORAGE_KEYS.notifyOnTakeover] as boolean) || false);
      // Remember the persisted webhook so a transient validation failure during
      // a later save cannot wipe it (mirrors notifications.ts last-known-good).
      lastKnownGoodWebhookUrl = (res[STORAGE_KEYS.webhookUrl] as string) || "";

      // O1 reasoning settings: effort/force are enums with form defaults; the
      // budget is only persisted when the user set it (llm-direct reads it as
      // a positive integer and treats absence as "no override").
      setVal("reasoningEffort", (res[STORAGE_KEYS.reasoningEffort] as string) ?? "medium");
      const storedBudget = res[STORAGE_KEYS.reasoningBudget];
      setVal(
        "reasoningBudget",
        typeof storedBudget === "number" && Number.isFinite(storedBudget) && storedBudget > 0
          ? String(Math.floor(storedBudget))
          : "",
      );
      setVal("forceReasoning", (res[STORAGE_KEYS.forceReasoning] as string) ?? "auto");

      // O8: the provider-scoped record wins over the flat mirror when the
      // saved provider has one (mirrors readProviderConfig's nested-first read
      // so the Options UI shows exactly what the runtime will use).
      const providerConfigs = res[STORAGE_KEYS.providerConfigs];
      const nestedForProvider =
        providerConfigs &&
        typeof providerConfigs === "object" &&
        !Array.isArray(providerConfigs) &&
        (providerConfigs as Record<string, unknown>)[savedProvider] &&
        typeof (providerConfigs as Record<string, unknown>)[savedProvider] === "object" &&
        !Array.isArray((providerConfigs as Record<string, unknown>)[savedProvider])
          ? (providerConfigs as Record<string, unknown>)[savedProvider] as Record<string, unknown>
          : null;
      if (nestedForProvider) {
        if (typeof nestedForProvider.model === "string") setVal("model", nestedForProvider.model);
        if (typeof nestedForProvider.baseUrl === "string") setVal("baseUrl", nestedForProvider.baseUrl);
        if (typeof nestedForProvider.resourceName === "string") setVal("resourceName", nestedForProvider.resourceName);
      }

      // Hydrate the authoritative provider-config store from exactly what the
      // DOM now holds (the nested providerConfigs record already won over the
      // flat mirror). PROVIDER_SELECTED is idempotent for the initial id, so a
      // fresh page load never clears the hydrated model.
      const modelEl = document.getElementById("model") as HTMLInputElement | null;
      const baseUrlEl = document.getElementById("baseUrl") as HTMLInputElement | null;
      const resourceNameEl = document.getElementById("resourceName") as HTMLInputElement | null;
      providerConfigStore.dispatch({ type: "PROVIDER_SELECTED", provider: savedProvider });
      providerConfigStore.dispatch({ type: "MODEL_SELECTED", model: modelEl?.value ?? "" });
      providerConfigStore.dispatch({ type: "BASE_URL_CHANGED", baseUrl: baseUrlEl?.value ?? "" });
      providerConfigStore.dispatch({ type: "RESOURCE_NAME_CHANGED", resourceName: resourceNameEl?.value ?? "" });

      updateProviderUI();
      settingsSyncStore.dispatch({ type: "SETTINGS_LOAD_OK" });
    },
  );
}

// ─── Save settings ─────────────────────────────────────────────────────────

let saveQueue: Promise<unknown> = Promise.resolve();

// ─── Webhook validation memo ────────────────────────────────────────────────
// `resolveAndValidateWebhookUrl` performs a live chrome.dns.resolve round-trip.
// saveSettings runs on every autosave, so the verdict is memoized per URL —
// the DNS check only re-runs when the URL actually changed.
const webhookValidationCache = new Map<string, SsrfCheckResult>();
const WEBHOOK_VALIDATION_CACHE_MAX = 20;

async function cachedWebhookValidation(url: string): Promise<SsrfCheckResult> {
  const cached = webhookValidationCache.get(url);
  if (cached) return cached;
  const result = await resolveAndValidateWebhookUrl(url);
  if (webhookValidationCache.size >= WEBHOOK_VALIDATION_CACHE_MAX) {
    const oldest = webhookValidationCache.keys().next().value;
    if (oldest !== undefined) webhookValidationCache.delete(oldest);
  }
  webhookValidationCache.set(url, result);
  return result;
}

// ─── Change tracking ────────────────────────────────────────────────────────
// agentMode/maxSteps are also written by the sidepanel while Options is open.
// Re-writing them from page-load-time state on unrelated saves would revert a
// sidepanel change, so they are persisted only when their control changed here.
let agentModeChanged = false;
let maxStepsChanged = false;
document.getElementById("agentMode")?.addEventListener("change", () => { agentModeChanged = true; });
document.getElementById("maxSteps")?.addEventListener("input", () => { maxStepsChanged = true; });

export function saveSettings(): Promise<boolean> {
  settingsSyncStore.dispatch({ type: "SETTINGS_SAVE_START" });
  const run = saveQueue.then(() => doSaveSettings(), () => doSaveSettings());
  saveQueue = run.catch(() => undefined);
  return run;
}

async function doSaveSettings(): Promise<boolean> {
  const invalid: string[] = [];
  const maxSteps = readInt("maxSteps", 100, 1, 500, invalid);
  const maxActions = readInt("maxActions", DEFAULT_MAX_ACTIONS, 1, MAX_ACTIONS, invalid);
  const plannerInterval = readInt("plannerInterval", 5, 1, 20, invalid);
  const maxFailures = readInt("maxFailures", 5, 1, 10, invalid);

  const costCapRaw = ($("costCap") as HTMLInputElement).value.trim();
  let costCap = 0;
  if (costCapRaw !== "") {
    const parsed = Number(costCapRaw);
    if (/^\d+(\.\d+)?$/.test(costCapRaw) && parsed >= 0 && parsed <= 1_000_000) {
      costCap = parsed;
    } else {
      invalid.push("costCap");
      ($("costCap") as HTMLInputElement).value = "0";
    }
  }

  const baseUrlRaw = ($("baseUrl") as HTMLInputElement).value.trim();
  const baseUrlValid = baseUrlRaw !== "" && isHttpUrl(baseUrlRaw);
  if (baseUrlRaw !== "" && !baseUrlValid) {
    invalid.push("baseUrl"); ($("baseUrl") as HTMLInputElement).value = "";
  }
  const webhookUrlRaw = ($("webhookUrl") as HTMLInputElement).value.trim();
  const webhookCheck = webhookUrlRaw !== "" ? await cachedWebhookValidation(webhookUrlRaw) : null;
  let webhookPersist = webhookUrlRaw;
  if (webhookUrlRaw !== "" && webhookCheck && !webhookCheck.ok) {
    if (validateWebhookUrl(webhookUrlRaw).ok) {
      // The DNS-free guard passed but the resolving check failed — a transient
      // resolver error/unavailability, not a bad URL. Do not wipe the field or
      // the persisted value; keep the previous webhook and warn.
      console.warn("[options] webhook URL failed the DNS-based SSRF check; keeping the previous value:", webhookCheck.reason);
      webhookPersist = lastKnownGoodWebhookUrl;
    } else {
      invalid.push("webhookUrl");
      ($("webhookUrl") as HTMLInputElement).value = "";
      webhookPersist = "";
    }
  }

  if (invalid.length > 0) {
    await alertModal({
      title: "Invalid value",
      message: `The following field(s) had an out-of-range value and were reset to their default: ${invalid.join(", ")}.`,
    });
  }

  // Retention bound: a stored webhook URL can never exceed the cap, so a
  // pasted/hostile value cannot balloon storage or the SSRF input surface.
  webhookPersist = clampWebhookUrl(webhookPersist);

  const droppedDomains: string[] = [];
  const sq = Math.min(100, Math.max(50, parseInt(($("screenshotQuality") as HTMLInputElement).value, 10) || 80));
  ($("screenshotQuality") as HTMLInputElement).value = String(sq);

  // O1 reasoning settings. The effort/force selects only ever hold sanctioned
  // values (populateReasoningControls rebuilds them from the model catalog), so
  // an out-of-set value can only come from tampering — fall back to the default
  // instead of persisting junk. The budget is an optional positive integer; an
  // empty field is an explicit "no override" and must REMOVE the stored key
  // (llm-direct reads absence as no budget).
  const effortRaw = ($("reasoningEffort") as HTMLSelectElement).value;
  const reasoningEffort =
    effortRaw === "low" || effortRaw === "medium" || effortRaw === "high" ? effortRaw : "medium";
  const forceRaw = ($("forceReasoning") as HTMLSelectElement).value;
  const forceReasoning =
    forceRaw === "on" || forceRaw === "off" || forceRaw === "auto" ? forceRaw : "auto";
  const budgetRaw = ($("reasoningBudget") as HTMLInputElement).value.trim();
  let reasoningBudget: number | undefined;
  if (budgetRaw !== "") {
    const parsed = Number(budgetRaw);
    if (/^\d+$/.test(budgetRaw) && Number.isFinite(parsed) && parsed > 0) {
      reasoningBudget = Math.floor(parsed);
    } else {
      ($("reasoningBudget") as HTMLInputElement).value = "";
    }
  }

  // Optional model-context override (tokens): a positive integer ≥ 1000. Empty
  // field = explicit "no override" (REMOVES the stored key — llm-direct reads
  // absence as catalog-derived/fixed profiles). An out-of-range value is reset
  // instead of persisted.
  const ctxRawEl = document.getElementById("contextTokens") as HTMLInputElement | null;
  let contextTokens: number | undefined;
  if (ctxRawEl) {
    const ctxRaw = ctxRawEl.value.trim();
    if (ctxRaw !== "") {
      const parsed = Number(ctxRaw);
      if (/^\d+$/.test(ctxRaw) && Number.isFinite(parsed) && parsed >= 1000) {
        contextTokens = Math.floor(parsed);
      } else {
        ctxRawEl.value = "";
      }
    }
  }

  const providerId = ($("provider") as HTMLSelectElement).value || DEFAULT_PROVIDER_ID;

  // Sync the authoritative provider-config store with the values about to be
  // persisted (the DOM is the render of the user's selection). This is the
  // catch-all: every autosave path — provider change, model commit, baseUrl/
  // resourceName edits — funnels through here, so the store cannot drift from
  // what the user actually selected.
  const resourceNameValue = (document.getElementById("resourceName") as HTMLInputElement | null)?.value.trim() ?? "";
  providerConfigStore.dispatch({ type: "PROVIDER_SELECTED", provider: providerId });
  providerConfigStore.dispatch({ type: "MODEL_SELECTED", model: ($("model") as HTMLInputElement).value });
  providerConfigStore.dispatch({ type: "BASE_URL_CHANGED", baseUrl: baseUrlValid ? baseUrlRaw : "" });
  providerConfigStore.dispatch({ type: "RESOURCE_NAME_CHANGED", resourceName: resourceNameValue });

  // O8: keep every provider's nested entry (so switching providers restores
  // each one's config) and mirror the ACTIVE provider's flat values into its
  // entry. `provenance: "user"` marks the nested values as user-set (trusted).
  const storedConfigsRes = await chrome.storage.local.get(STORAGE_KEYS.providerConfigs);
  const storedConfigs = storedConfigsRes[STORAGE_KEYS.providerConfigs];
  const providerConfigs: Record<string, unknown> =
    storedConfigs && typeof storedConfigs === "object" && !Array.isArray(storedConfigs)
      ? { ...(storedConfigs as Record<string, unknown>) }
      : {};
  providerConfigs[providerId] = {
    model: ($("model") as HTMLInputElement).value,
    baseUrl: baseUrlValid ? baseUrlRaw : "",
    resourceName: (document.getElementById("resourceName") as HTMLInputElement | null)?.value.trim() ?? "",
    provenance: "user",
  };

  const data: Record<string, string | number | string[] | boolean | Record<string, unknown>> = {
    provider: providerId,
    model: ($("model") as HTMLInputElement).value,
    provenance: "user",
    baseUrl: baseUrlValid ? baseUrlRaw : "",
    resourceName: (document.getElementById("resourceName") as HTMLInputElement | null)?.value.trim() ?? "",
    maxActions, plannerInterval, maxFailures, costCap,
    ...(maxStepsChanged ? { maxSteps } : {}),
    defaultTask: ($("defaultTask") as HTMLTextAreaElement).value,
    [STORAGE_KEYS.screenshotQuality]: sq,
    [STORAGE_KEYS.enableScreenshots]: ($("enableScreenshots") as HTMLInputElement).checked,
    [STORAGE_KEYS.stealthEnabled]: ($("enableStealth") as HTMLInputElement).checked === true,
    [STORAGE_KEYS.visionMode]: (document.querySelector('input[name="visionMode"]:checked') as HTMLInputElement | null)?.value || "disabled",
    [STORAGE_KEYS.allowedDomains]: parseDomains(($("allowedDomains") as HTMLTextAreaElement).value, droppedDomains),
    [STORAGE_KEYS.blockedDomains]: parseDomains(($("blockedDomains") as HTMLTextAreaElement).value, droppedDomains),
    ...(agentModeChanged ? { [STORAGE_KEYS.agentMode]: (document.getElementById("agentMode") as HTMLSelectElement | null)?.value || "standard" } : {}),
    [STORAGE_KEYS.webhookUrl]: webhookPersist,
    [STORAGE_KEYS.notifyOnCompletion]: ($("notifyOnCompletion") as HTMLInputElement).checked,
    [STORAGE_KEYS.notifyOnError]: ($("notifyOnError") as HTMLInputElement).checked,
    [STORAGE_KEYS.notifyOnTakeover]: ($("notifyOnTakeover") as HTMLInputElement).checked,
    [STORAGE_KEYS.reasoningEffort]: reasoningEffort,
    ...(reasoningBudget !== undefined ? { [STORAGE_KEYS.reasoningBudget]: reasoningBudget } : {}),
    [STORAGE_KEYS.forceReasoning]: forceReasoning,
    ...(contextTokens !== undefined ? { [STORAGE_KEYS.contextTokens]: contextTokens } : {}),
    [STORAGE_KEYS.providerConfigs]: providerConfigs,
  };

  return new Promise<boolean>((resolve) => {
    const finish = (): void => {
      // Only a successful write advances the revert cache (the failure path
      // resolves without calling finish), so a failed save reverts to the
      // genuinely last-good URL rather than the unsaved one.
      lastKnownGoodWebhookUrl = webhookPersist;
      settingsSyncStore.dispatch({ type: "SETTINGS_SAVE_OK" });
      showSaved();
      // "no silent changes": every successful write renders + announces
      // a confirmable summary of the sensitive categories (mode, cost cap,
      // provider/destination, screenshots, stealth, vision, webhook/retention)
      // so a destination/permission/cost/mode/retention change is never silent.
      const summary = composeSettingsSaveSummary(data);
      const summaryEl = document.getElementById("saveSummary");
      if (summaryEl) summaryEl.textContent = summary;
      announce("Settings saved — " + summary);
      if (droppedDomains.length) {
        void alertModal({ title: "Invalid domain entries ignored", message: "The following domain lines were not valid bare hostnames and were dropped:\n" + droppedDomains.join("\n") });
      }
      resolve(true);
    };
    chrome.storage.local.set(data, async () => {
      if (chrome.runtime.lastError) {
        console.warn("[options] storage.set failed:", chrome.runtime.lastError);
        settingsSyncStore.dispatch({
          type: "SETTINGS_SAVE_FAIL",
          error: chrome.runtime.lastError.message || "Settings could not be saved.",
        });
        announce("Failed to save settings: " + (chrome.runtime.lastError?.message || "unknown error"), {
          assertive: true,
        });
        void alertModal({ title: "Save failed", message: "Failed to save settings: " + (chrome.runtime.lastError?.message || "unknown error") });
        resolve(false);
        return;
      }
      // An emptied budget field must clear any previously-stored value (the set
      // payload above omits the key when the field is empty — Chrome storage
      // only writes the given keys, so a stale budget would otherwise survive).
      if (reasoningBudget === undefined) {
        try {
          await chrome.storage.local.remove(STORAGE_KEYS.reasoningBudget);
        } catch (e) {
          console.warn("[options] reasoning budget removal failed:", e);
        }
      }
      // Same empty-field cleanup for the context override (guarded by element
      // presence so a page without the field never touches storage).
      if (contextTokens === undefined && document.getElementById("contextTokens")) {
        try {
          await chrome.storage.local.remove(STORAGE_KEYS.contextTokens);
        } catch (e) {
          console.warn("[options] context-tokens removal failed:", e);
        }
      }
      const apiKeyValue = ($("apiKey") as HTMLInputElement).value;
      const rememberKey = (document.getElementById("rememberApiKey") as HTMLInputElement | null)?.checked ?? false;
      if (typeof chrome !== "undefined" && chrome.storage?.session) {
        try {
          await syncRememberedApiKey(apiKeyValue, rememberKey, providerId);
        } catch (e) {
          console.warn("[options] credential save failed:", e);
        }
        finish();
      } else {
        // No session storage: the key cannot be held in memory. The checkbox
        // still governs the on-disk mirror, so an un-checked box removes any
        // previously remembered copy.
        try {
          await syncRememberedApiKey(apiKeyValue, rememberKey, providerId);
        } catch (e) {
          console.warn("[options] remember-key mirror failed:", e);
        }
        void alertModal({
          title: "API key not saved",
          message: "This browser/profile does not support in-memory session storage, so your provider API key is NOT saved in memory. It is stored in the encrypted device vault only if you opted into \"remember on this device\". Re-enter the key each session, or use a browser/profile that supports session storage.",
        });
        finish();
      }
    });
  });
}

export function initAutoSave(): void { initAutoSaveImpl(saveSettings); }

// ─── Secrets ───────────────────────────────────────────────────────────────

document.getElementById("addSecret")?.addEventListener("click", async () => {
  const { setSecret: setSecretInStore } = await import("@/lib/agent/secrets");
  const name = ($("secretName") as HTMLInputElement).value.trim();
  const value = ($("secretValue") as HTMLInputElement).value.trim();
  if (!name) { ($("secretName") as HTMLInputElement).focus(); return; }
  if (!value) { ($("secretValue") as HTMLInputElement).focus(); return; }
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
    await alertModal({ title: "Invalid secret name", message: "Secret names must start with a letter and contain only letters, digits, and underscores, so they can be used as %name% placeholders." });
    ($("secretName") as HTMLInputElement).focus();
    return;
  }
  await setSecretInStore(name, value);
  ($("secretName") as HTMLInputElement).value = "";
  ($("secretValue") as HTMLInputElement).value = "";
  await renderSecrets();
  showSaved();
});

void migrateSecretsFromLocalToSession();
