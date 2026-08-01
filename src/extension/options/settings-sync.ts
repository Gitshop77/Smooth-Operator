/**
 * options/settings-sync.ts — load/save settings + secrets.
 * Helpers extracted to settings-sync-utils.ts; keys in storage-keys.ts.
 */

import { $ } from "@/extension/shared";
import { syncRememberedApiKey } from "@/extension/api-key-storage";
import { updateProviderUI } from "./provider-config-ui";
import { PROVIDER_META, DEFAULT_PROVIDER_ID } from "./providers";
import { alertModal } from "./modal";
import { resolveAndValidateWebhookUrl } from "@/lib/agent/llm/route/ssrf";
import { MAX_ACTIONS, DEFAULT_MAX_ACTIONS } from "@/lib/validations";
import {
  readInt, isHttpUrl, isHostname, setVal, setChecked, parseDomains,
  populateProviderSelect, showSaved, initAutoSave as initAutoSaveImpl,
  migrateSecretsFromLocalToSession, renderSecrets,
} from "./settings-sync-utils";
import { STORAGE_KEYS } from "./storage-keys";

export { readInt, isHttpUrl, isHostname, showSaved, renderSecrets };

populateProviderSelect();

// ─── Load settings ─────────────────────────────────────────────────────────

if (typeof chrome !== "undefined" && chrome.storage?.local) {
  chrome.storage.local.get(
    [
      STORAGE_KEYS.provider, STORAGE_KEYS.apiKey, STORAGE_KEYS.rememberApiKey,
      STORAGE_KEYS.model,
      STORAGE_KEYS.baseUrl, STORAGE_KEYS.resourceName, STORAGE_KEYS.maxSteps,
      STORAGE_KEYS.maxActions, STORAGE_KEYS.plannerInterval,
      STORAGE_KEYS.maxFailures, STORAGE_KEYS.costCap, STORAGE_KEYS.defaultTask,
      "screenshotQuality", "enableScreenshots", "stealthEnabled",
      "enableLocalVision", "visionMode", "allowedDomains", "blockedDomains",
      STORAGE_KEYS.notifyOnCompletion, STORAGE_KEYS.notifyOnError,
      STORAGE_KEYS.notifyOnTakeover, STORAGE_KEYS.webhookUrl, "agentMode",
    ],
    (res) => {
      if (chrome.runtime.lastError) {
        console.warn("[options] storage.get failed:", chrome.runtime.lastError);
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
        ["model", "model", ""], ["baseUrl", "baseUrl", ""],
        ["resourceName", "resourceName", ""], ["agentMode", "agentMode", "standard"],
        ["defaultTask", "defaultTask", ""], ["webhookUrl", "webhookUrl", ""],
      ];
      for (const [elId, key, def] of textFields) setVal(elId, (res[key] as string) ?? def);

      const numFields: Array<[string, string, number]> = [
        ["maxSteps", "maxSteps", 100], ["maxActions", "maxActions", 10],
        ["plannerInterval", "plannerInterval", 5], ["maxFailures", "maxFailures", 5],
      ];
      for (const [elId, key, def] of numFields) setVal(elId, String(res[key] ?? def));

      const costCap = typeof res.costCap === "number" ? Math.max(0, res.costCap) : 0;
      setVal("costCap", String(costCap));
      setVal("screenshotQuality", String(res.screenshotQuality ?? 80));
      setChecked("enableScreenshots", res.enableScreenshots !== false);
      setChecked("enableStealth", res.stealthEnabled === true);

      const visionMode = (res.visionMode as string) || (res.enableLocalVision === true ? "always" : "disabled");
      const visionRadio = Array.from(
        document.querySelectorAll<HTMLInputElement>('input[name="visionMode"]'),
      ).find((r) => r.value === visionMode) ?? null;
      if (visionRadio) visionRadio.checked = true;

      const toLines = (v: unknown) => Array.isArray(v) ? (v as string[]).join("\n") : "";
      setVal("allowedDomains", toLines(res.allowedDomains));
      setVal("blockedDomains", toLines(res.blockedDomains));
      setChecked("notifyOnCompletion", (res.notifyOnCompletion as boolean) || false);
      setChecked("notifyOnError", (res.notifyOnError as boolean) || false);
      setChecked("notifyOnTakeover", (res.notifyOnTakeover as boolean) || false);
      updateProviderUI();
    },
  );
}

// ─── Save settings ─────────────────────────────────────────────────────────

let saveQueue: Promise<unknown> = Promise.resolve();

export function saveSettings(): Promise<boolean> {
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
  const webhookCheck = webhookUrlRaw !== "" ? await resolveAndValidateWebhookUrl(webhookUrlRaw) : null;
  if (webhookUrlRaw !== "" && webhookCheck && !webhookCheck.ok) {
    invalid.push("webhookUrl"); ($("webhookUrl") as HTMLInputElement).value = "";
  }

  if (invalid.length > 0) {
    await alertModal({
      title: "Invalid value",
      message: `The following field(s) had an out-of-range value and were reset to their default: ${invalid.join(", ")}.`,
    });
  }

  const droppedDomains: string[] = [];
  const sq = Math.min(100, Math.max(50, parseInt(($("screenshotQuality") as HTMLInputElement).value, 10) || 80));
  ($("screenshotQuality") as HTMLInputElement).value = String(sq);

  const data: Record<string, string | number | string[] | boolean> = {
    provider: ($("provider") as HTMLSelectElement).value,
    model: ($("model") as HTMLInputElement).value,
    provenance: "user",
    baseUrl: baseUrlValid ? baseUrlRaw : "",
    resourceName: (document.getElementById("resourceName") as HTMLInputElement | null)?.value.trim() ?? "",
    maxSteps, maxActions, plannerInterval, maxFailures, costCap,
    defaultTask: ($("defaultTask") as HTMLTextAreaElement).value,
    screenshotQuality: sq,
    enableScreenshots: ($("enableScreenshots") as HTMLInputElement).checked,
    stealthEnabled: ($("enableStealth") as HTMLInputElement).checked === true,
    visionMode: (document.querySelector('input[name="visionMode"]:checked') as HTMLInputElement | null)?.value || "disabled",
    allowedDomains: parseDomains(($("allowedDomains") as HTMLTextAreaElement).value, droppedDomains),
    blockedDomains: parseDomains(($("blockedDomains") as HTMLTextAreaElement).value, droppedDomains),
    agentMode: (document.getElementById("agentMode") as HTMLSelectElement | null)?.value || "standard",
    [STORAGE_KEYS.webhookUrl]: webhookUrlRaw !== "" && webhookCheck?.ok ? webhookUrlRaw : "",
    [STORAGE_KEYS.notifyOnCompletion]: ($("notifyOnCompletion") as HTMLInputElement).checked,
    [STORAGE_KEYS.notifyOnError]: ($("notifyOnError") as HTMLInputElement).checked,
    [STORAGE_KEYS.notifyOnTakeover]: ($("notifyOnTakeover") as HTMLInputElement).checked,
  };

  return new Promise<boolean>((resolve) => {
    const finish = (): void => {
      showSaved();
      if (droppedDomains.length) {
        void alertModal({ title: "Invalid domain entries ignored", message: "The following domain lines were not valid bare hostnames and were dropped:\n" + droppedDomains.join("\n") });
      }
      resolve(true);
    };
    chrome.storage.local.set(data, async () => {
      if (chrome.runtime.lastError) {
        console.warn("[options] storage.set failed:", chrome.runtime.lastError);
        void alertModal({ title: "Save failed", message: "Failed to save settings: " + (chrome.runtime.lastError?.message || "unknown error") });
        resolve(false);
        return;
      }
      const apiKeyValue = ($("apiKey") as HTMLInputElement).value;
      const rememberKey = (document.getElementById("rememberApiKey") as HTMLInputElement | null)?.checked ?? false;
      if (typeof chrome !== "undefined" && chrome.storage?.session) {
        chrome.storage.session.set({ [STORAGE_KEYS.apiKey]: apiKeyValue }, async () => {
          if (chrome.runtime.lastError) {
            console.warn("[options] session key set failed:", chrome.runtime.lastError);
          }
          // Mirror sync runs REGARDLESS of the session-write outcome, so an
          // un-checked box always removes the on-disk copy even when the
          // session write failed.
          try {
            await syncRememberedApiKey(apiKeyValue, rememberKey);
          } catch (e) {
            console.warn("[options] remember-key mirror failed:", e);
          }
          finish();
        });
      } else {
        // No session storage: the key cannot be held in memory. The checkbox
        // still governs the on-disk mirror, so an un-checked box removes any
        // previously remembered copy.
        try {
          await syncRememberedApiKey(apiKeyValue, rememberKey);
        } catch (e) {
          console.warn("[options] remember-key mirror failed:", e);
        }
        void alertModal({
          title: "API key not saved",
          message: "This browser/profile does not support in-memory session storage, so your provider API key is NOT saved in memory. It is written to disk only if you opted into \"remember on this device\". Re-enter the key each session, or use a browser/profile that supports session storage.",
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
