/**
 * options/settings-sync.ts — STORAGE_KEYS + load/save settings + secrets
 * management (secrets migration + render + add handler).
 *
 * Owns the `STORAGE_KEYS` map (re-exported for the other options/* modules:
 * scheduled-tasks, custom-tools, history). The load handler reads every
 * persisted setting from `chrome.storage.local` and populates the form; the
 * save handler validates numeric inputs and writes back. Secrets management
 * delegates to `@/lib/agent/secrets` as the single source of truth (the
 * settings UI used to write to `chrome.storage.local` while the
 * runtime substitution module read from `chrome.storage.session`).
 */

import { $, DEFAULT_COCKPIT_URL, COCKPIT_URL_STORAGE_KEY, escapeHtml } from "@/extension/shared";
import {
  listSecrets as listSecretsFromStore,
  setSecret as setSecretInStore,
  deleteSecret as deleteSecretFromStore,
  type SecretEntry as StoredSecretEntry,
} from "@/lib/agent/secrets";
import { updateProviderUI } from "./provider-config-ui";

// ─── Storage keys ──────────────────────────────────────────────────────────

export const STORAGE_KEYS = {
  provider: "provider",
  apiKey: "apiKey",
  model: "model",
  baseUrl: "baseUrl",
  maxSteps: "maxSteps",
  maxActions: "maxActions",
  plannerInterval: "plannerInterval",
  maxFailures: "maxFailures",
  costCap: "costCap",
  defaultTask: "defaultTask",
  secrets: "open_cowork_secrets",
  scheduledTasks: "open_cowork_scheduled_tasks",
  runHistory: "open_cowork_run_history",
  customTools: "__opencowork_custom_tools",
} as const;

// ─── Types ─────────────────────────────────────────────────────────────────

// ─── Load settings ─────────────────────────────────────────────────────────

chrome.storage.local.get(
  [
    STORAGE_KEYS.provider,
    STORAGE_KEYS.apiKey,
    STORAGE_KEYS.model,
    STORAGE_KEYS.baseUrl,
    STORAGE_KEYS.maxSteps,
    STORAGE_KEYS.maxActions,
    STORAGE_KEYS.plannerInterval,
    STORAGE_KEYS.maxFailures,
    STORAGE_KEYS.costCap,
    STORAGE_KEYS.defaultTask,
    "screenshotQuality",
    "enableScreenshots",
    "enableLocalVision",
    "visionMode",
    "allowedDomains",
    "blockedDomains",
    COCKPIT_URL_STORAGE_KEY,
  ],
  (res) => {
    if (chrome.runtime.lastError) {
      console.warn("[options] storage.get failed:", chrome.runtime.lastError);
      return;
    }
    // Use `??` (not `||`) so empty-string / 0 values are preserved.
    ($("provider") as HTMLSelectElement).value = (res.provider as string) ?? "openai";
    // SECURITY: apiKey is read back from chrome.storage.local here. That store is
    // UNENCRYPTED and MV3 provides NO secret store, so the raw key is persisted in
    // plaintext on disk. Prefer OAuth / pass-through auth where the provider
    // supports it to avoid storing long-lived API keys at all. Never console.log
    // the value.
    ($("apiKey") as HTMLInputElement).value = (res.apiKey as string) ?? "";
    ($("model") as HTMLInputElement).value = (res.model as string) ?? "";
    ($("baseUrl") as HTMLInputElement).value = (res.baseUrl as string) ?? "";
    ($("maxSteps") as HTMLInputElement).value = String(res.maxSteps ?? 100);
    ($("maxActions") as HTMLInputElement).value = String(res.maxActions ?? 10);
    ($("plannerInterval") as HTMLInputElement).value = String(res.plannerInterval ?? 5);
    ($("maxFailures") as HTMLInputElement).value = String(res.maxFailures ?? 5);
    // Validate costCap non-negative.
    const costCap = typeof res.costCap === "number" ? Math.max(0, res.costCap) : 0;
    ($("costCap") as HTMLInputElement).value = String(costCap);
    ($("defaultTask") as HTMLTextAreaElement).value = (res.defaultTask as string) ?? "";
    // screenshot quality setting
    ($("screenshotQuality") as HTMLInputElement).value = String(res.screenshotQuality ?? 80);
    ($("enableScreenshots") as HTMLInputElement).checked = res.enableScreenshots !== false;
    // Vision mode: backward compat — if visionMode is unset, derive from enableLocalVision
    const visionMode = (res.visionMode as string) || (res.enableLocalVision === true ? "always" : "disabled");
    const visionRadio = document.querySelector(`input[name="visionMode"][value="${visionMode}"]`) as HTMLInputElement | null;
    if (visionRadio) visionRadio.checked = true;
    // load domain allow/block lists (stored as arrays, displayed as
    // newline-separated text).
    const allowedDomains = Array.isArray(res.allowedDomains) ? (res.allowedDomains as string[]).join("\n") : "";
    const blockedDomains = Array.isArray(res.blockedDomains) ? (res.blockedDomains as string[]).join("\n") : "";
    ($("allowedDomains") as HTMLTextAreaElement).value = allowedDomains;
    ($("blockedDomains") as HTMLTextAreaElement).value = blockedDomains;
    // Cockpit URL: fall back to DEFAULT_COCKPIT_URL when unset/empty.
    const storedCockpitUrl = res[COCKPIT_URL_STORAGE_KEY] as string | undefined;
    ($("cockpitUrl") as HTMLInputElement).value =
      typeof storedCockpitUrl === "string" && storedCockpitUrl.trim() ? storedCockpitUrl : DEFAULT_COCKPIT_URL;
    // Update hints/placeholders based on the loaded provider.
    updateProviderUI();
  }
);

// ─── Save settings ─────────────────────────────────────────────────────────

$("save").addEventListener("click", () => {
  // Validate numeric inputs.
  const maxSteps = parseInt(($("maxSteps") as HTMLInputElement).value, 10);
  const maxActions = parseInt(($("maxActions") as HTMLInputElement).value, 10);
  const plannerInterval = parseInt(($("plannerInterval") as HTMLInputElement).value, 10);
  const maxFailures = parseInt(($("maxFailures") as HTMLInputElement).value, 10);
  const costCap = parseFloat(($("costCap") as HTMLInputElement).value);
  if (Number.isNaN(maxSteps) || maxSteps < 1) { alert("maxSteps must be a positive integer"); return; }
  if (Number.isNaN(maxActions) || maxActions < 1) { alert("maxActions must be a positive integer"); return; }
  if (Number.isNaN(plannerInterval) || plannerInterval < 1) { alert("plannerInterval must be a positive integer"); return; }
  if (Number.isNaN(maxFailures) || maxFailures < 1) { alert("maxFailures must be a positive integer"); return; }
  if (Number.isNaN(costCap) || costCap < 0) { alert("costCap must be a non-negative number"); return; }
  // parse domain allow/block lists from newline-separated text to arrays.
  const parseDomains = (text: string): string[] =>
    text.split("\n").map((d) => d.trim()).filter((d) => d.length > 0);
  const allowedDomains = parseDomains(($("allowedDomains") as HTMLTextAreaElement).value);
  const blockedDomains = parseDomains(($("blockedDomains") as HTMLTextAreaElement).value);

  const data: Record<string, string | number | string[] | boolean> = {
    provider: ($("provider") as HTMLSelectElement).value,
    // SECURITY: apiKey is persisted to chrome.storage.local here in PLAINTEXT.
    // MV3 has no secure secret store, so this is unavoidable for the current
    // design. Recommend OAuth where the provider supports it; never console.log
    // the value. Surfaced errors must go through redactKeyLeak (provider-config-ui).
    apiKey: ($("apiKey") as HTMLInputElement).value,
    model: ($("model") as HTMLInputElement).value,
    baseUrl: ($("baseUrl") as HTMLInputElement).value,
    maxSteps,
    maxActions,
    plannerInterval,
    maxFailures,
    costCap,
    defaultTask: ($("defaultTask") as HTMLTextAreaElement).value,
    screenshotQuality: Math.min(100, Math.max(50, parseInt(($("screenshotQuality") as HTMLInputElement).value, 10) || 80)),
    enableScreenshots: ($("enableScreenshots") as HTMLInputElement).checked,
    // Vision mode from radio group
    visionMode: (document.querySelector('input[name="visionMode"]:checked') as HTMLInputElement | null)?.value || "disabled",
    // Backward compat: also set enableLocalVision for older code paths
    enableLocalVision: (document.querySelector('input[name="visionMode"]:checked') as HTMLInputElement | null)?.value !== "disabled",
    allowedDomains,
    blockedDomains,
    // Cockpit URL — stored under its own key so the side panel can read it
    // without scanning every other setting. Trim + fall back to default so
    // empty input doesn't break the Open Cockpit button.
    [COCKPIT_URL_STORAGE_KEY]: (($("cockpitUrl") as HTMLInputElement).value.trim() || DEFAULT_COCKPIT_URL),
  };
  chrome.storage.local.set(data, () => {
    if (chrome.runtime.lastError) {
      console.warn("[options] storage.set failed:", chrome.runtime.lastError);
      alert("Failed to save settings: " + (chrome.runtime.lastError?.message || "unknown error"));
      return;
    }
    const saved = $("saved");
    saved.classList.add("show");
    setTimeout(() => saved.classList.remove("show"), 1500);
  });
});

// ─── Secrets management ────────────────────────────────────────────────────
//
// The settings UI previously wrote to `chrome.storage.local`
// while the runtime substitution module (`secrets.ts`) read from
// `chrome.storage.session` — the same key string in two disjoint storage
// areas, with zero shared code. A secret saved in Options was invisible to
// `substituteSecrets()`. Now we delegate to `secrets.ts`'s exported
// functions (`listSecrets` / `setSecret` / `deleteSecret`) as the single
// source of truth, so the UI and the runtime share one storage area + one
// code path. A one-time migration moves any pre-fix secrets from local to
// session.

/**
 * One-time migration: if secrets exist in `chrome.storage.local` (the
 * old, pre-fix location) but not in `chrome.storage.session` (the current
 * location), copy them over and remove the old local entry. Idempotent —
 * safe to call on every Options page load.
 */
async function migrateSecretsFromLocalToSession(): Promise<void> {
  try {
    const localRes = await chrome.storage.local.get(STORAGE_KEYS.secrets);
    const localSecrets = localRes[STORAGE_KEYS.secrets] as StoredSecretEntry[] | undefined;
    if (!Array.isArray(localSecrets) || localSecrets.length === 0) return;
    // Check session — only migrate if session doesn't already have them.
    const sessionSecrets = await listSecretsFromStore();
    if (sessionSecrets.length > 0) {
      // Session already has SOME secrets. A previous run may have partially
      // migrated (setSecretInStore threw mid-loop, local copy was preserved).
      // Before removing the local copy, migrate any local secrets whose name
      // isn't already in session — otherwise those secrets are lost forever.
      const sessionNames = new Set(sessionSecrets.map((s) => s.name));
      let anyFailed = false;
      for (const s of localSecrets) {
        if (
          s &&
          typeof s.name === "string" &&
          typeof s.value === "string" &&
          !sessionNames.has(s.name)
        ) {
          try {
            await setSecretInStore(s.name, s.value);
          } catch {
            // This secret couldn't be migrated. DON'T remove the local copy —
            // otherwise the secret is lost forever (not in session, deleted
            // from local). Leave it for the next migration attempt; the user
            // can also re-add it via the Options UI.
            anyFailed = true;
          }
        }
      }
      // Only remove the local copy if every secret migrated successfully.
      // If any failed, keep the local copy so the unmigrated secrets survive.
      if (!anyFailed) {
        await chrome.storage.local.remove(STORAGE_KEYS.secrets);
      }
      return;
    }
    // Migrate each secret to the session store.
    for (const s of localSecrets) {
      if (s && typeof s.name === "string" && typeof s.value === "string") {
        await setSecretInStore(s.name, s.value);
      }
    }
    // Remove the old local copy.
    await chrome.storage.local.remove(STORAGE_KEYS.secrets);
  } catch (e) {
    console.warn("[options] secrets migration failed:", e);
  }
}

/** Render the secrets list. Call after every mutation. */
export async function renderSecrets(): Promise<void> {
  const secrets = await listSecretsFromStore();
  const list = $("secretsList") as HTMLDivElement;
  list.innerHTML = "";
  if (secrets.length === 0) {
    list.innerHTML = '<p class="empty-hint">No secrets stored. Add one above.</p>';
    return;
  }
  for (const s of secrets) {
    const item = document.createElement("div");
    item.className = "secret-item";
    // escape the secret name before interpolating into innerHTML.
    // Without this, a user who enters `foo</span><img src=x onerror=...>`
    // as a secret name would get the markup executed when this list renders.
    // Self-XSS only (the user can only attack themselves), but it violates
    // the project's own escape discipline used everywhere else.
    item.innerHTML =
      `<span class="name">%${escapeHtml(s.name)}%</span>` +
      `<span class="value">${"•".repeat(Math.min(s.value.length, 20))}</span>` +
      `<button type="button">Delete</button>`;
    item.querySelector("button")!.addEventListener("click", async () => {
      await deleteSecretFromStore(s.name);
      await renderSecrets();
    });
    list.appendChild(item);
  }
}

$("addSecret").addEventListener("click", async () => {
  const name = ($("secretName") as HTMLInputElement).value.trim();
  // Trim the secret value too — leading/trailing whitespace is almost never intended.
  const value = ($("secretValue") as HTMLInputElement).value.trim();
  if (!name) {
    ($("secretName") as HTMLInputElement).focus();
    return;
  }
  if (!value) {
    ($("secretValue") as HTMLInputElement).focus();
    return;
  }
  // use secrets.ts's setSecret — single source of truth for storage.
  await setSecretInStore(name, value);
  ($("secretName") as HTMLInputElement).value = "";
  ($("secretValue") as HTMLInputElement).value = "";
  await renderSecrets();
});

// Run the one-time migration on Options page load.
void migrateSecretsFromLocalToSession();
