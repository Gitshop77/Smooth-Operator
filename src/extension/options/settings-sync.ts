/**
 * options/settings-sync.ts — STORAGE_KEYS + load/save settings + secrets.
 *
 * Owns the `STORAGE_KEYS` map (re-exported for scheduled-tasks, custom-tools,
 * history). The load handler reads every setting from `chrome.storage.local`
 * and populates the form; the save handler writes them back.
 *
 * P3 redesign changes:
 * - The provider `<select>` is built from `PROVIDERS` (options/providers.ts)
 * at module load, so the saved provider always has a matching `<option>`
 * (fixes the old default-provider mismatch where a saved `xai`/`google`
 * silently fell back to the first hardcoded `<option>`).
 * - The page now uses a SINGLE coherent save model: every field auto-persists
 * on change/blur, and one consistent "Saved" cue is shown everywhere.
 * There is no split-brain between a global Save button and auto-persisting
 * tabs — `initAutoSave()` wires change listeners to `saveSettings()`.
 * - Validation errors use the styled modal instead of native `alert()`.
 */

import { $, DEFAULT_COCKPIT_URL, COCKPIT_URL_STORAGE_KEY, escapeHtml } from "@/extension/shared";
import {
  listSecrets as listSecretsFromStore,
  setSecret as setSecretInStore,
  deleteSecret as deleteSecretFromStore,
  type SecretEntry as StoredSecretEntry,
} from "@/lib/agent/secrets";
import { updateProviderUI, populateModelSuggestions } from "./provider-config-ui";
import { PROVIDERS, PROVIDER_META, DEFAULT_PROVIDER_ID } from "./providers";
import { alertModal } from "./modal";
import { validateWebhookUrl } from "@/lib/agent/llm/route/ssrf";

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
 // Notification rule keys (added for the Notify tab redesign).
  notifyOnCompletion: "notifyOnCompletion",
  notifyOnError: "notifyOnError",
  notifyOnTakeover: "notifyOnTakeover",
  webhookUrl: "webhookUrl",
 // Quick-prompt CRUD (Prompts tab).
  quickPrompts: "open_cowork_quick_prompts",
} as const;

// ─── Provider <select> built from source ─────────────────────────────────────

/** Populate the provider dropdown from the single PROVIDERS catalog. */
function populateProviderSelect(): void {
  const sel = $("provider") as HTMLSelectElement;
  sel.innerHTML = "";
  for (const p of PROVIDERS) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.label;
    sel.appendChild(opt);
  }
}

// Build it synchronously at import time so the async load handler below always
// has every provider `<option>` available before it sets `.value`.
populateProviderSelect();

// ─── "Saved" cue (consistent across every tab) ───────────────────────────────

let savedTimer: ReturnType<typeof setTimeout> | null = null;
/** Flash the shared "Saved" cue. Used by every auto-save path. */
export function showSaved(): void {
  const saved = $("saved");
  saved.setAttribute("role", "status");
  saved.setAttribute("aria-live", "polite");
  saved.classList.add("show");
  if (savedTimer) clearTimeout(savedTimer);
  savedTimer = setTimeout(() => saved.classList.remove("show"), 1500);
}

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
    STORAGE_KEYS.notifyOnCompletion,
    STORAGE_KEYS.notifyOnError,
    STORAGE_KEYS.notifyOnTakeover,
    STORAGE_KEYS.webhookUrl,
  ],
  (res) => {
    if (chrome.runtime.lastError) {
      console.warn("[options] storage.get failed:", chrome.runtime.lastError);
      return;
    }
 // Provider: select the SAVED value. Because populateProviderSelect() ran
 // first, every catalog provider is present as an <option>, so the saved id
 // (even xai/google) selects correctly instead of falling back to the first
 // option. As a safety net, if the saved id isn't in the list we append it.
    const savedProvider = (res.provider as string) ?? DEFAULT_PROVIDER_ID;
    const sel = $("provider") as HTMLSelectElement;
    if (!PROVIDER_META[savedProvider]) {
      const opt = document.createElement("option");
      opt.value = savedProvider;
      opt.textContent = savedProvider;
      sel.appendChild(opt);
    }
    sel.value = savedProvider;

 // SECURITY: the API key lives in `chrome.storage.session` (in-memory, never
 // on disk). Read it from there; fall back to `local` only for installs that
 // have not yet migrated. Never console.log the value.
    if (typeof chrome !== "undefined" && chrome.storage?.session) {
      chrome.storage.session.get([STORAGE_KEYS.apiKey], (sres) => {
        if (chrome.runtime.lastError) {
 // Session store unavailable — fall back to any legacy local value
 // rather than leaving the field blank.
          ($("apiKey") as HTMLInputElement).value = (res.apiKey as string) ?? "";
          return;
        }
        const sessionKey = (sres[STORAGE_KEYS.apiKey] as string) ?? "";
        ($("apiKey") as HTMLInputElement).value =
          sessionKey || ((res.apiKey as string) ?? "");
      });
    } else {
      ($("apiKey") as HTMLInputElement).value = (res.apiKey as string) ?? "";
    }
    ($("model") as HTMLInputElement).value = (res.model as string) ?? "";
    ($("baseUrl") as HTMLInputElement).value = (res.baseUrl as string) ?? "";
    ($("maxSteps") as HTMLInputElement).value = String(res.maxSteps ?? 100);
    ($("maxActions") as HTMLInputElement).value = String(res.maxActions ?? 10);
    ($("plannerInterval") as HTMLInputElement).value = String(res.plannerInterval ?? 5);
    ($("maxFailures") as HTMLInputElement).value = String(res.maxFailures ?? 5);
    const costCap = typeof res.costCap === "number" ? Math.max(0, res.costCap) : 0;
    ($("costCap") as HTMLInputElement).value = String(costCap);
    ($("defaultTask") as HTMLTextAreaElement).value = (res.defaultTask as string) ?? "";
    ($("screenshotQuality") as HTMLInputElement).value = String(res.screenshotQuality ?? 80);
    ($("enableScreenshots") as HTMLInputElement).checked = res.enableScreenshots !== false;
    const visionMode = (res.visionMode as string) || (res.enableLocalVision === true ? "always" : "disabled");
 // Resolve the matching radio by comparing values (NOT by interpolating
 // `visionMode` into a `querySelector` string — a corrupt/attacker-influenced
 // stored value could break out of the attribute selector). Iterate the
 // radio group and set `.checked` on an exact match only.
    const visionRadio = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[name="visionMode"]'),
    ).find((r) => r.value === visionMode) ?? null;
    if (visionRadio) visionRadio.checked = true;
    const allowedDomains = Array.isArray(res.allowedDomains) ? (res.allowedDomains as string[]).join("\n") : "";
    const blockedDomains = Array.isArray(res.blockedDomains) ? (res.blockedDomains as string[]).join("\n") : "";
    ($("allowedDomains") as HTMLTextAreaElement).value = allowedDomains;
    ($("blockedDomains") as HTMLTextAreaElement).value = blockedDomains;
    const storedCockpitUrl = res[COCKPIT_URL_STORAGE_KEY] as string | undefined;
    ($("cockpitUrl") as HTMLInputElement).value =
      typeof storedCockpitUrl === "string" && storedCockpitUrl.trim() ? storedCockpitUrl : DEFAULT_COCKPIT_URL;
 // Notify tab.
    ($("notifyOnCompletion") as HTMLInputElement).checked = (res.notifyOnCompletion as boolean) || false;
    ($("notifyOnError") as HTMLInputElement).checked = (res.notifyOnError as boolean) || false;
    ($("notifyOnTakeover") as HTMLInputElement).checked = (res.notifyOnTakeover as boolean) || false;
    ($("webhookUrl") as HTMLInputElement).value = (res.webhookUrl as string) ?? "";
 // Update hints/placeholders based on the loaded provider.
    updateProviderUI();
  }
);

// ─── Save settings (auto-save entry point) ───────────────────────────────────

/** Read a bounded integer field; on invalid input, reset to default + flag it. */
function readInt(id: string, def: number, min: number, max: number, invalid: string[]): number {
  const el = $(id) as HTMLInputElement;
  const raw = el.value.trim();
  if (raw === "") return def;
  const n = parseInt(raw, 10);
 // Reject trailing junk (`parseInt("5abc") → 5`) and any non-integer input
 // (finding: readInt silently accepts trailing-junk integers). Only a clean
 // all-digit string is accepted; otherwise reset to default + flag.
  if (!/^\d+$/.test(raw) || Number.isNaN(n) || n < min || n > max) {
    invalid.push(id);
    el.value = String(def);
    return def;
  }
  return n;
}

/** True if `value` is an absolute http(s) URL. Exported for reuse by sibling modules. */
export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** True if `candidate` is a valid IPv6 address literal (no brackets/port). */
function isIpv6Literal(candidate: string): boolean {
  if (!/^[0-9a-fA-F:]+$/.test(candidate)) return false;
  if (candidate.includes("::")) return true; // compressed form
  const groups = candidate.split(":");
  return groups.length === 8 && groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g));
}

/** True if `value` is a bare hostname (optionally `*.` wildcard), no scheme/path/port. */
function isHostname(value: string): boolean {
  if (!value || value.includes("/") || value.includes(" ")) return false;
  const candidate = value.startsWith("*.") ? value.slice(2) : value;
  if (!candidate) return false;
 // IPv6 literals legitimately contain ':' (e.g. `2001:db8:1`) — accept them
 // as bare hosts. Only a GENUINE IPv6 literal is allowed through the ':' fast
 // path; a `host:port` form (e.g. `evil.com:9999`) is NOT a valid IPv6 and
 // falls through to the URL validation below, which rejects it because the
 // parsed hostname (`evil.com`) won't equal the candidate (`evil.com:9999`).
  if (candidate.includes(":")) return isIpv6Literal(candidate);
  try {
    const u = new URL("http://" + candidate);
 // Compare lowercased so valid UPPERCASE and IDN/punycode hostnames are not
 // silently discarded (URL lower-cases the hostname, so an exact-match with
 // the original casing would otherwise reject legitimate entries).
    return u.hostname.toLowerCase() === candidate.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Tail of the save queue. Every `saveSettings()` call chains its work onto this
 * promise so that N rapid auto-saves run strictly one-after-another.
 *
 * The previous single-token scheme (`saveInFlight`) only serialized ONE waiter:
 * when 3+ auto-saves fired while a save was in flight, every waiter awaited the
 * SAME in-flight promise and then all proceeded to call `doSaveSettings()`
 * concurrently — racing/overwriting each other . Chaining onto
 * a single moving tail guarantees each save fully completes before the next
 * begins, giving deterministic last-write-wins ordering.
 */
let saveQueue: Promise<unknown> = Promise.resolve();

/**
 * Serialize overlapping auto-saves. Rapid edits run sequentially so the "Saved"
 * cue and the validation modal can't race each other, and concurrent
 * `chrome.storage.local.set` writes can't overwrite one another.
 */
export function saveSettings(): Promise<boolean> {
 // Chain onto the tail regardless of whether the previous save resolved or
 // rejected, so one failure never wedges the queue.
  const run = saveQueue.then(
    () => doSaveSettings(),
    () => doSaveSettings(),
  );
 // Keep the tail alive (and its rejection handled) for the next caller.
  saveQueue = run.catch(() => undefined);
  return run;
}

/**
 * Validate + persist every Connection/Agent field. Returns true on success.
 * On validation failure, surfaces a styled modal and resets the bad field(s).
 */
async function doSaveSettings(): Promise<boolean> {
  const invalid: string[] = [];
  const maxSteps = readInt("maxSteps", 100, 1, 500, invalid);
  const maxActions = readInt("maxActions", 10, 1, 20, invalid);
  const plannerInterval = readInt("plannerInterval", 5, 1, 20, invalid);
  const maxFailures = readInt("maxFailures", 5, 1, 10, invalid);

  const costCapRaw = ($("costCap") as HTMLInputElement).value.trim();
  let costCap = 0;
  if (costCapRaw !== "") {
 // Reject trailing junk (parseFloat("5abc") → 5) and apply a sane upper
 // bound, mirroring `readInt`. An absurd cap could otherwise drive runaway
 // spend logic in the agent loop.
    if (!/^\d+(\.\d+)?$/.test(costCapRaw)) {
      invalid.push("costCap");
      costCap = 0;
      ($("costCap") as HTMLInputElement).value = "0";
    } else {
      costCap = parseFloat(costCapRaw);
      const MAX_COST_CAP = 1_000_000;
      if (Number.isNaN(costCap) || costCap < 0 || costCap > MAX_COST_CAP) {
        invalid.push("costCap");
        costCap = 0;
        ($("costCap") as HTMLInputElement).value = "0";
      }
    }
  }

 // Validate cockpitUrl / baseUrl are absolute http(s) URLs (or empty). A
 // non-http(s) value could later be opened as a tab (cockpitUrl) or used to
 // build requests (baseUrl), so reject it at save time.
  const cockpitUrlRaw = ($("cockpitUrl") as HTMLInputElement).value.trim();
  if (cockpitUrlRaw !== "" && !isHttpUrl(cockpitUrlRaw)) {
    invalid.push("cockpitUrl");
    ($("cockpitUrl") as HTMLInputElement).value = DEFAULT_COCKPIT_URL;
  }
  const baseUrlRaw = ($("baseUrl") as HTMLInputElement).value.trim();
  if (baseUrlRaw !== "" && !isHttpUrl(baseUrlRaw)) {
    invalid.push("baseUrl");
    ($("baseUrl") as HTMLInputElement).value = "";
  }
  const webhookUrlRaw = ($("webhookUrl") as HTMLInputElement).value.trim();
  const webhookCheck = webhookUrlRaw !== "" ? validateWebhookUrl(webhookUrlRaw) : null;
  if (webhookUrlRaw !== "" && webhookCheck && !webhookCheck.ok) {
    invalid.push("webhookUrl");
    ($("webhookUrl") as HTMLInputElement).value = "";
  }

  if (invalid.length > 0) {
    const names = invalid.join(", ");
    await alertModal({
      title: "Invalid value",
      message: `The following field(s) had an out-of-range value and were reset to their default: ${names}.`,
    });
  }

  const droppedDomains: string[] = [];
  const parseDomains = (text: string): string[] => {
    const lines = text.split("\n").map((d) => d.trim()).filter((d) => d.length > 0);
    const valid: string[] = [];
    for (const line of lines) {
      if (isHostname(line)) valid.push(line);
      else droppedDomains.push(line);
    }
    return valid;
  };

  const screenshotQualityEl = $("screenshotQuality") as HTMLInputElement;
  const sq = Math.min(100, Math.max(50, parseInt(screenshotQualityEl.value, 10) || 80));
  screenshotQualityEl.value = String(sq);

  const data: Record<string, string | number | string[] | boolean> = {
    provider: ($("provider") as HTMLSelectElement).value,
 // SECURITY: the provider API key is a bearer credential and is the single
 // most sensitive secret the extension holds. It is persisted to
 // `chrome.storage.session` (in-memory, cleared on extension unload/restart,
 // NEVER written to disk or synced) rather than `chrome.storage.local`
 // (which is unencrypted on disk and synced to Google's servers when
 // extension sync is on). This matches how the project already stores
 // user `%secret%` values (see `src/lib/agent/secrets.ts`). The key is
 // written to the session store below and removed from `local` so it is
 // never persisted in plaintext. Trade-off: the user must re-enter the key
 // after a browser/extension restart. Never console.log the value.
    model: ($("model") as HTMLInputElement).value,
    baseUrl: baseUrlRaw !== "" && isHttpUrl(baseUrlRaw) ? baseUrlRaw : "",
    maxSteps,
    maxActions,
    plannerInterval,
    maxFailures,
    costCap,
    defaultTask: ($("defaultTask") as HTMLTextAreaElement).value,
    screenshotQuality: sq,
    enableScreenshots: ($("enableScreenshots") as HTMLInputElement).checked,
 // `visionMode` is the single source of truth for the vision setting. The
 // legacy `enableLocalVision` key is intentionally NOT written here — every
 // reader (llm-direct, run-helpers, vision-status) already prefers
 // `visionMode` and only falls back to `enableLocalVision` for backward
 // compatibility with pre-existing stored values. Persisting both keys
 // invites divergence if a writer updates one without the other.
    visionMode: (document.querySelector('input[name="visionMode"]:checked') as HTMLInputElement | null)?.value || "disabled",
    allowedDomains: parseDomains(($("allowedDomains") as HTMLTextAreaElement).value),
    blockedDomains: parseDomains(($("blockedDomains") as HTMLTextAreaElement).value),
    [COCKPIT_URL_STORAGE_KEY]: (cockpitUrlRaw !== "" && isHttpUrl(cockpitUrlRaw) ? cockpitUrlRaw : DEFAULT_COCKPIT_URL),
    [STORAGE_KEYS.webhookUrl]: webhookUrlRaw !== "" && webhookCheck?.ok ? webhookUrlRaw : "",
    [STORAGE_KEYS.notifyOnCompletion]: ($("notifyOnCompletion") as HTMLInputElement).checked,
    [STORAGE_KEYS.notifyOnError]: ($("notifyOnError") as HTMLInputElement).checked,
    [STORAGE_KEYS.notifyOnTakeover]: ($("notifyOnTakeover") as HTMLInputElement).checked,
  };

  return new Promise<boolean>((resolve) => {
    chrome.storage.local.set(data, () => {
      if (chrome.runtime.lastError) {
        console.warn("[options] storage.set failed:", chrome.runtime.lastError);
        void alertModal({
          title: "Save failed",
          message: "Failed to save settings: " + (chrome.runtime.lastError?.message || "unknown error"),
        });
        resolve(false);
        return;
      }
 // Persist the provider API key to the in-memory session store (see the
 // SECURITY note on the data object) and ensure no plaintext copy lingers
 // in `chrome.storage.local`.
      const apiKeyValue = ($("apiKey") as HTMLInputElement).value;
      if (typeof chrome !== "undefined" && chrome.storage?.session) {
        chrome.storage.session.set({ [STORAGE_KEYS.apiKey]: apiKeyValue }, () => {
          if (chrome.runtime.lastError) {
            console.warn("[options] session key set failed:", chrome.runtime.lastError);
          } else {
 // Remove any legacy plaintext copy from local storage only when the
 // session write succeeded; on failure keep the legacy local copy.
            chrome.storage.local.remove(STORAGE_KEYS.apiKey);
          }
        });
      } else {
 // No session store available — fall back to local (less safe) rather
 // than silently discarding the key. Surface a clear warning so the user
 // knows their API key is being persisted to disk in PLAINTEXT
 // (finding: API key persisted as plaintext when session store is
 // unavailable). This is an accepted trade-off for environments without
 // `chrome.storage.session`; prefer a browser/profile that supports it.
        console.warn(
          "[options] SECURITY: chrome.storage.session unavailable — API key written " +
            "to chrome.storage.local in PLAINTEXT (on disk). Use a browser/profile with " +
            "session storage, or paste the key per session.",
        );
        chrome.storage.local.set({ [STORAGE_KEYS.apiKey]: apiKeyValue }, () => {
          if (chrome.runtime.lastError) {
            console.warn("[options] local API key fallback write failed:", chrome.runtime.lastError);
          }
        });
      }
      showSaved();
      if (droppedDomains.length) {
        void alertModal({
          title: "Invalid domain entries ignored",
          message: "The following domain lines were not valid bare hostnames and were dropped:\n" + droppedDomains.join("\n"),
        });
      }
      resolve(true);
    });
  });
}

/** Wire auto-save change listeners to every Connection/Agent field. */
export function initAutoSave(): void {
  const saveIds = [
    "cockpitUrl", "apiKey", "model", "baseUrl",
    "maxSteps", "maxActions", "plannerInterval", "maxFailures", "costCap",
    "defaultTask", "screenshotQuality", "allowedDomains", "blockedDomains",
    "webhookUrl", "notifyOnCompletion", "notifyOnError", "notifyOnTakeover",
  ];
  for (const id of saveIds) {
    document.getElementById(id)?.addEventListener("change", () => void saveSettings());
  }
  $("enableScreenshots")?.addEventListener("change", () => void saveSettings());
  document.querySelectorAll<HTMLInputElement>('input[name="visionMode"]').forEach((radio) => {
    radio.addEventListener("change", () => void saveSettings());
  });
  $("provider")?.addEventListener("change", () => {
    updateProviderUI();
    void populateModelSuggestions();
    void saveSettings();
  });
}

// ─── Secrets management ────────────────────────────────────────────────────
//
// Delegates to `@/lib/agent/secrets` as the single source of truth for storage.

async function migrateSecretsFromLocalToSession(): Promise<void> {
  try {
 // Migrate any legacy plaintext API key from `chrome.storage.local` into the
 // in-memory session store (security: the key must never persist to disk).
    if (typeof chrome !== "undefined" && chrome.storage?.session) {
      const localKey = await chrome.storage.local.get([STORAGE_KEYS.apiKey]);
      const apiKeyValue = localKey[STORAGE_KEYS.apiKey] as string | undefined;
      if (typeof apiKeyValue === "string" && apiKeyValue.length > 0) {
        await chrome.storage.session.set({ [STORAGE_KEYS.apiKey]: apiKeyValue });
        await chrome.storage.local.remove(STORAGE_KEYS.apiKey);
      }
    }
    const localRes = await chrome.storage.local.get(STORAGE_KEYS.secrets);
    const localSecrets = localRes[STORAGE_KEYS.secrets] as StoredSecretEntry[] | undefined;
    if (!Array.isArray(localSecrets) || localSecrets.length === 0) return;
    const sessionSecrets = await listSecretsFromStore();
    if (sessionSecrets.length > 0) {
      const sessionNames = new Set(sessionSecrets.map((s) => s.name));
      let anyFailed = false;
      for (const s of localSecrets) {
        if (s && typeof s.name === "string" && typeof s.value === "string" && !sessionNames.has(s.name)) {
          try {
            await setSecretInStore(s.name, s.value);
          } catch {
            anyFailed = true;
          }
        }
      }
      if (!anyFailed) await chrome.storage.local.remove(STORAGE_KEYS.secrets);
      return;
    }
    for (const s of localSecrets) {
      if (s && typeof s.name === "string" && typeof s.value === "string") {
        await setSecretInStore(s.name, s.value);
      }
    }
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
    item.innerHTML =
      `<span class="name">%${escapeHtml(s.name)}%</span>` +
      `<span class="value">${"•".repeat(Math.min(s.value.length, 20))}</span>` +
      `<button type="button" class="secret-delete" aria-label="Delete secret %${escapeHtml(s.name)}%">Delete</button>`;
    item.querySelector("button")!.addEventListener("click", async () => {
      await deleteSecretFromStore(s.name);
      await renderSecrets();
      showSaved();
    });
    list.appendChild(item);
  }
}

$("addSecret")?.addEventListener("click", async () => {
  const name = ($("secretName") as HTMLInputElement).value.trim();
  const value = ($("secretValue") as HTMLInputElement).value.trim();
  if (!name) { ($("secretName") as HTMLInputElement).focus(); return; }
  if (!value) { ($("secretValue") as HTMLInputElement).focus(); return; }
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
    await alertModal({
      title: "Invalid secret name",
      message:
        "Secret names must start with a letter and contain only letters, digits, and underscores, so they can be used as %name% placeholders.",
    });
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
