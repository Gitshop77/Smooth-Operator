import { $, escapeHtml } from "@/extension/shared";
import {
  listSecrets as listSecretsFromStore,
  setSecret as setSecretInStore,
  deleteSecret as deleteSecretFromStore,
} from "@/lib/agent/secrets";
import { updateProviderUI, populateModelSuggestions } from "./provider-config-ui";
import { PROVIDERS } from "./providers";
import { STORAGE_KEYS } from "./storage-keys";
import { migrateRememberedCredential } from "../credential-service";
import { alertModal, confirmModal } from "./modal";
import { providerConfigStore } from "./stores";

export function readInt(id: string, def: number, min: number, max: number, invalid: string[]): number {
  const el = $(id) as HTMLInputElement;
  const raw = el.value.trim();
  if (raw === "") return def;
  const n = parseInt(raw, 10);
  if (!/^\d+$/.test(raw) || Number.isNaN(n) || n < min || n > max) {
    invalid.push(id);
    el.value = String(def);
    return def;
  }
  return n;
}

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function isIpv6Literal(candidate: string): boolean {
  if (!candidate) return false;
  try {
    const u = new URL(`http://[${candidate}]`);
    // URL.hostname returns the BRACKETED form ("[2001:db8::1]") for an
    // IPv6 literal, so compare against `[candidate]` (an unbracketed
    // comparison used to reject every real IPv6 literal).
    return u.hostname === `[${candidate}]`;
  } catch {
    return false;
  }
}

export function isHostname(value: string): boolean {
  if (!value || value.includes("/") || value.includes(" ")) return false;
  const candidate = value.startsWith("*.") ? value.slice(2) : value;
  if (!candidate) return false;
  if (/^\d+$/.test(candidate)) return false;
  if (candidate.includes(":")) return isIpv6Literal(candidate);
  try {
    const u = new URL("http://" + candidate);
    return u.hostname.toLowerCase() === candidate.toLowerCase();
  } catch {
    return false;
  }
}

export function setVal(id: string, value: string): void {
  const el = document.getElementById(id);
  if (el) (el as HTMLInputElement).value = value;
}

export function setChecked(id: string, value: boolean): void {
  const el = document.getElementById(id);
  if (el) (el as HTMLInputElement).checked = value;
}

export function parseDomains(text: string, droppedDomains: string[]): string[] {
  const lines = text.split("\n").map((d) => d.trim()).filter((d) => d.length > 0);
  const valid: string[] = [];
  for (const line of lines) {
    if (isHostname(line)) valid.push(line);
    else droppedDomains.push(line);
  }
  return valid;
}

export function populateProviderSelect(): void {
  const sel = document.getElementById("provider") as HTMLSelectElement | null;
  if (!sel) return;
  sel.innerHTML = "";
  for (const p of PROVIDERS) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.label;
    sel.appendChild(opt);
  }
}

let savedTimer: ReturnType<typeof setTimeout> | null = null;
export function showSaved(): void {
  // Non-throwing: called from a dozen mutation paths, so a missing node must
  // degrade rather than throw (same guard style as setVal/setChecked).
  const saved = document.getElementById("saved");
  if (!saved) return;
  saved.classList.add("show");
  if (savedTimer) clearTimeout(savedTimer);
  savedTimer = setTimeout(() => saved.classList.remove("show"), 1500);
}

/**
 * Compose the confirmable save summary shown after every settings write
 * ("no silent changes" invariant). The sensitive categories —
 * mode, cost, destination (provider/baseUrl), data-collection permissions,
 * vision, and delivery/retention (webhook) — must never change silently, so
 * the summary states exactly what was persisted. Pure: no DOM, no storage.
 */
export function composeSettingsSaveSummary(data: Record<string, unknown>): string {
  const parts: string[] = [];
  const mode = data.agentMode;
  if (typeof mode === "string" && mode.length > 0) parts.push(`mode: ${mode}`);
  if (typeof data.costCap === "number") {
    parts.push(data.costCap > 0 ? `cost cap: $${data.costCap.toFixed(2)}` : "cost cap: none");
  }
  if (typeof data.provider === "string" && data.provider.length > 0) {
    const baseUrl = typeof data.baseUrl === "string" && data.baseUrl.length > 0 ? data.baseUrl : "default endpoint";
    parts.push(`provider: ${data.provider} (${baseUrl})`);
  }
  if (typeof data.enableScreenshots === "boolean") {
    parts.push(`screenshots: ${data.enableScreenshots ? "on" : "off"}`);
  }
  if (typeof data.stealthEnabled === "boolean") {
    parts.push(`stealth: ${data.stealthEnabled ? "on" : "off"}`);
  }
  if (typeof data.visionMode === "string" && data.visionMode.length > 0) {
    parts.push(`vision: ${data.visionMode}`);
  }
  const webhook = typeof data.webhookUrl === "string" ? data.webhookUrl : "";
  parts.push(webhook.length > 0 ? `notify webhook: ${webhook}` : "notify webhook: none");
  // ALWAYS emit the domain scope lines so clearing the allow-list (a
  // security-scope widening) or adding blocked domains can never pass
  // silently.
  if (Array.isArray(data.allowedDomains)) {
    parts.push(`allowed domains: ${data.allowedDomains.length > 0 ? data.allowedDomains.length : "none"}`);
  }
  if (Array.isArray(data.blockedDomains)) {
    parts.push(`blocked domains: ${data.blockedDomains.length}`);
  }
  return parts.join(" · ");
}

export function initAutoSave(saveSettings: () => Promise<boolean>): void {
  const saveIds = [
    "apiKey", "model", "baseUrl", "resourceName",
    "maxSteps", "maxActions", "plannerInterval", "maxFailures", "costCap",
    "defaultTask", "screenshotQuality", "screenshotImageTokens", "screenshotMaxDimension", "screenshotMaxBytes", "allowedDomains", "blockedDomains", "enableStealth",
    "agentMode",
    "reasoningEffort", "reasoningBudget", "forceReasoning",
    "contextTokens",
  ];

  let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  const debouncedSave = (): void => {
    if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
    saveDebounceTimer = setTimeout(() => void saveSettings(), 300);
  };

  for (const id of saveIds) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener("input", debouncedSave);
    el.addEventListener("change", () => {
      // Typing-then-tabbing fires `input`+`change` back-to-back; cancel the
      // pending debounce so the immediate blur save is the ONLY write.
      if (saveDebounceTimer) {
        clearTimeout(saveDebounceTimer);
        saveDebounceTimer = null;
      }
      void saveSettings();
    });
  }
  const enableScreenshots = document.getElementById("enableScreenshots");
  if (enableScreenshots) enableScreenshots.addEventListener("change", () => void saveSettings());
  const rememberApiKey = document.getElementById("rememberApiKey");
  if (rememberApiKey) rememberApiKey.addEventListener("change", () => void saveSettings());
  document.querySelectorAll<HTMLInputElement>('input[name="visionMode"]').forEach((radio) => {
    radio.addEventListener("change", () => void saveSettings());
  });
  $("provider")?.addEventListener("change", () => {
    // A real provider change funnels through the authoritative store first:
    // the reducer clears the previous provider's model and bumps the
    // generation so any in-flight connection test for the old selection is
    // dropped when it resolves. updateProviderUI renders the new capabilities.
    providerConfigStore.dispatch({
      type: "PROVIDER_SELECTED",
      provider: ($("provider") as HTMLSelectElement).value,
    });
    updateProviderUI();
    void populateModelSuggestions();
    void saveSettings();
  });
}

export async function migrateSecretsFromLocalToSession(): Promise<void> {
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.session) {
      const localRes = await chrome.storage.local.get([STORAGE_KEYS.apiKey, STORAGE_KEYS.rememberApiKey]);
      const localKey = localRes[STORAGE_KEYS.apiKey] as string | undefined;
      const sessionRes = await chrome.storage.session.get([STORAGE_KEYS.apiKey]);
      const sessionKey = sessionRes[STORAGE_KEYS.apiKey] as string | undefined;
      // The migration runs at module import, concurrently with the first
      // saveSettings write. If the session already holds a non-empty key, a
      // save already happened — never overwrite that newer value with the
      // stale local mirror.
      if (
        typeof sessionKey !== "string" || sessionKey.length === 0
      ) {
        if (typeof localKey === "string" && localKey.length > 0) {
          await chrome.storage.session.set({ [STORAGE_KEYS.apiKey]: localKey });
          // The local mirror is kept ONLY when the user opted in via
          // "remember on this device"; otherwise move the key out of disk.
          if (localRes[STORAGE_KEYS.rememberApiKey] !== true) {
            await chrome.storage.local.remove(STORAGE_KEYS.apiKey);
          } else {
            // Legacy adapter: the source remains until the encrypted
            // vault copy and session hydration have both round-tripped.
            await migrateRememberedCredential();
          }
        }
      }
    }
    const localRes = await chrome.storage.local.get(STORAGE_KEYS.secrets);
    const localSecrets = localRes[STORAGE_KEYS.secrets] as Array<{ name: string; value: string }> | undefined;
    if (!Array.isArray(localSecrets) || localSecrets.length === 0) return;
    const sessionSecrets = await listSecretsFromStore();
    const sessionByName = new Map(sessionSecrets.map((s) => [s.name, s.value]));
    const migrated = new Set<string>();
    for (const s of localSecrets) {
      if (!s || typeof s.name !== "string" || typeof s.value !== "string") continue;
      const existing = sessionByName.get(s.name);
      let ok = false;
      if (existing !== undefined) {
        // Only count an existing entry as migrated when it is identical — a
        // differing local value is kept rather than silently dropped (session
        // wins for reads, but the local copy stays visible for the user).
        ok = existing === s.value;
      } else {
        try {
          await setSecretInStore(s.name, s.value);
          ok = true;
        } catch {
          ok = false;
        }
      }
      if (ok) migrated.add(s.name);
    }
    const remaining = localSecrets.filter(
      (s) => !(s && typeof s.name === "string" && migrated.has(s.name)),
    );
    if (remaining.length === 0) {
      await chrome.storage.local.remove(STORAGE_KEYS.secrets);
    } else {
      await chrome.storage.local.set({ [STORAGE_KEYS.secrets]: remaining });
    }
  } catch (e) {
    console.warn("[options] secrets migration failed:", e);
  }
}

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
      // Destructive-action gate: deleting a secret value requires
      // explicit acknowledgement — prompts referencing %name% fail to resolve
      // until the value is re-added.
      const ok = await confirmModal({
        title: "Delete secret",
        message: `Delete secret %${s.name}%? Prompts using %${s.name}% will not resolve until you re-add the value.`,
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
      try {
        await deleteSecretFromStore(s.name);
      } catch (e) {
        console.warn("[options] delete secret failed:", e);
        void alertModal({
          title: "Could not delete secret",
          message: e instanceof Error ? e.message : String(e),
        });
      }
      try {
        await renderSecrets();
      } catch (e) {
        console.warn("[options] render secrets failed:", e);
      }
      showSaved();
    });
    list.appendChild(item);
  }
}
