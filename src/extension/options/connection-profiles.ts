import { announce } from "../accessibility";
import { updateProviderUI } from "./provider-config-ui";
import { saveSettings } from "./settings-sync";
import { STORAGE_KEYS } from "./storage-keys";

export interface ConnectionProfileV1 {
  version: 1;
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  resourceName: string;
  contextTokens?: number;
}

function isProfile(value: unknown): value is ConnectionProfileV1 {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return p.version === 1 &&
    typeof p.id === "string" && !!p.id &&
    typeof p.name === "string" && !!p.name.trim() &&
    typeof p.provider === "string" && !!p.provider &&
    typeof p.model === "string" && !!p.model &&
    typeof p.baseUrl === "string" &&
    typeof p.resourceName === "string" &&
    (p.contextTokens === undefined || (Number.isSafeInteger(p.contextTokens) && (p.contextTokens as number) >= 1000));
}

export function parseConnectionProfiles(value: unknown): ConnectionProfileV1[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.filter((entry): entry is ConnectionProfileV1 => {
    if (!isProfile(entry) || seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  }).slice(0, 50);
}

export function activeConnectionProfileFromStorage(
  storage: Record<string, unknown>,
): ConnectionProfileV1 | null {
  const profiles = parseConnectionProfiles(storage[STORAGE_KEYS.connectionProfiles]);
  const active = storage[STORAGE_KEYS.activeConnectionProfile];
  return typeof active === "string" ? profiles.find((p) => p.id === active) ?? null : null;
}

function idForProfile(): string {
  return typeof crypto?.randomUUID === "function"
    ? crypto.randomUUID()
    : `profile-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function status(message: string, failure = false): void {
  const el = document.getElementById("connectionProfileStatus");
  if (el) {
    el.textContent = message;
    el.className = `test-result ${failure ? "failure" : "success"}`;
  }
  announce(message, { assertive: failure });
}

function render(profiles: ConnectionProfileV1[], activeId: string): void {
  const select = document.getElementById("connectionProfile") as HTMLSelectElement | null;
  const deleteButton = document.getElementById("deleteConnectionProfile") as HTMLButtonElement | null;
  if (!select) return;
  select.innerHTML = '<option value="">Current settings (not saved as a profile)</option>';
  for (const profile of profiles) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name;
    select.appendChild(option);
  }
  select.value = profiles.some((p) => p.id === activeId) ? activeId : "";
  if (deleteButton) deleteButton.disabled = !select.value;
  const active = profiles.find((p) => p.id === select.value);
  const name = document.getElementById("connectionProfileName") as HTMLInputElement | null;
  if (name && active) name.value = active.name;
}

function applyProfile(profile: ConnectionProfileV1): void {
  const provider = document.getElementById("provider") as HTMLSelectElement | null;
  if (provider) {
    provider.value = profile.provider;
    updateProviderUI();
  }
  const values: Record<string, string> = {
    model: profile.model,
    baseUrl: profile.baseUrl,
    resourceName: profile.resourceName,
    contextTokens: profile.contextTokens ? String(profile.contextTokens) : "",
  };
  for (const [id, value] of Object.entries(values)) {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (input) input.value = value;
  }
}

export async function initConnectionProfiles(): Promise<void> {
  const select = document.getElementById("connectionProfile") as HTMLSelectElement | null;
  const saveButton = document.getElementById("saveConnectionProfile") as HTMLButtonElement | null;
  const deleteButton = document.getElementById("deleteConnectionProfile") as HTMLButtonElement | null;
  if (!select || !saveButton || !deleteButton || !chrome.storage?.local) return;

  const load = async (): Promise<{ profiles: ConnectionProfileV1[]; activeId: string }> => {
    const stored = await chrome.storage.local.get([
      STORAGE_KEYS.connectionProfiles,
      STORAGE_KEYS.activeConnectionProfile,
    ]);
    return {
      profiles: parseConnectionProfiles(stored[STORAGE_KEYS.connectionProfiles]),
      activeId: typeof stored[STORAGE_KEYS.activeConnectionProfile] === "string"
        ? stored[STORAGE_KEYS.activeConnectionProfile] as string
        : "",
    };
  };

  const initial = await load();
  render(initial.profiles, initial.activeId);

  select.addEventListener("change", async () => {
    const state = await load();
    const profile = state.profiles.find((p) => p.id === select.value);
    if (!profile) {
      await chrome.storage.local.remove(STORAGE_KEYS.activeConnectionProfile);
      render(state.profiles, "");
      return;
    }
    applyProfile(profile);
    await chrome.storage.local.set({ [STORAGE_KEYS.activeConnectionProfile]: profile.id });
    await saveSettings();
    render(state.profiles, profile.id);
    status(`Default profile set to ${profile.name}.`);
  });

  saveButton.addEventListener("click", async () => {
    const nameInput = document.getElementById("connectionProfileName") as HTMLInputElement | null;
    const provider = (document.getElementById("provider") as HTMLSelectElement | null)?.value ?? "";
    const model = (document.getElementById("model") as HTMLInputElement | null)?.value.trim() ?? "";
    const name = nameInput?.value.trim() ?? "";
    if (!name || !provider || !model) {
      status("Enter a profile name and exact model id. For llama.cpp, clear Model and use Test connection to discover it.", true);
      return;
    }
    const state = await load();
    const existing = state.profiles.find((p) => p.id === select.value);
    const contextRaw = (document.getElementById("contextTokens") as HTMLInputElement | null)?.value ?? "";
    const context = Number(contextRaw);
    const profile: ConnectionProfileV1 = {
      version: 1,
      id: existing?.id ?? idForProfile(),
      name: name.slice(0, 80),
      provider,
      model,
      baseUrl: (document.getElementById("baseUrl") as HTMLInputElement | null)?.value.trim() ?? "",
      resourceName: (document.getElementById("resourceName") as HTMLInputElement | null)?.value.trim() ?? "",
      ...(Number.isSafeInteger(context) && context >= 1000 ? { contextTokens: context } : {}),
    };
    const profiles = existing
      ? state.profiles.map((p) => p.id === existing.id ? profile : p)
      : [...state.profiles, profile];
    await saveSettings();
    await chrome.storage.local.set({
      [STORAGE_KEYS.connectionProfiles]: profiles,
      [STORAGE_KEYS.activeConnectionProfile]: profile.id,
    });
    render(profiles, profile.id);
    status(`Saved ${profile.name} as the default profile.`);
  });

  deleteButton.addEventListener("click", async () => {
    const state = await load();
    const deleting = state.profiles.find((p) => p.id === select.value);
    if (!deleting) return;
    const profiles = state.profiles.filter((p) => p.id !== deleting.id);
    await chrome.storage.local.set({ [STORAGE_KEYS.connectionProfiles]: profiles });
    await chrome.storage.local.remove(STORAGE_KEYS.activeConnectionProfile);
    render(profiles, "");
    status(`Deleted profile ${deleting.name}.`);
  });
}
