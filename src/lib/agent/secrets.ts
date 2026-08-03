import { isExtensionWithSession } from "./runtime";
import type { SecretEntry, SubstituteSecretsOptions } from "./secrets-utils";
import {
  PLACEHOLDER_PATTERN,
  HAS_PLACEHOLDER,
  isValidSecretEntry,
  buildRedactionArtifacts,
} from "./secrets-utils";

const STORAGE_KEY = "open_cowork_secrets";

let mutationChain: Promise<unknown> = Promise.resolve();
function withSecretLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutationChain.then(fn, fn);
  mutationChain = run.then(() => undefined, () => undefined);
  return run;
}

let secretsResolvedExternally = false;
export function setSecretsResolvedExternally(value: boolean): void {
  secretsResolvedExternally = value;
}

let redactionCache: { key: string; artifacts: ReturnType<typeof buildRedactionArtifacts> } | null = null;

function getRedactionArtifacts(secrets: SecretEntry[]) {
  const key = JSON.stringify(secrets.map((s) => [s.name, s.value]));
  if (redactionCache && redactionCache.key === key) return redactionCache.artifacts;
  const artifacts = buildRedactionArtifacts(secrets);
  redactionCache = { key, artifacts };
  return artifacts;
}

async function persist(secrets: SecretEntry[]): Promise<void> {
  if (isExtensionWithSession()) {
    try {
      await chrome.storage.session.set({ [STORAGE_KEY]: secrets });
    } catch (e) {
      console.error("[secrets] chrome.storage.session.set failed:", e);
      throw e;
    }
  } else {
    if (typeof chrome !== "undefined" && chrome.storage?.session) {
      throw new Error(
        "[secrets] Refusing to use localStorage: chrome.storage.session is available but isExtensionWithSession() returned false.",
      );
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(secrets));
    } catch (e) {
      if (e instanceof DOMException && e.name === "QuotaExceededError") {
        console.error("[secrets] localStorage quota exceeded:", e);
      }
      throw e;
    }
  }
}

let secretsCache: SecretEntry[] | null = null;
let secretSetVersion = 0;
export function getSecretSetVersion(): number {
  return secretSetVersion;
}

// The options page writes secrets from its own module instance, so an
// in-instance write is not the only way the store changes. Without this
// listener the service worker would redact/substitute against a frozen
// secret set for its whole lifetime. Mirror the pattern used by
// persistent-memory.ts / domain-skills-data.ts / registry-utils.ts.
if (isExtensionWithSession() && typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes[STORAGE_KEY]) {
      secretsCache = null;
      redactionCache = null;
      secretSetVersion++;
    }
  });
}

export async function listSecrets(): Promise<SecretEntry[]> {
  if (secretsCache) return secretsCache;
  if (isExtensionWithSession()) {
    try {
      const res = await chrome.storage.session.get(STORAGE_KEY);
      const v = res[STORAGE_KEY];
      if (!Array.isArray(v)) return [];
      secretsCache = v.filter(isValidSecretEntry);
      return secretsCache;
    } catch (e) {
      console.error("[secrets] chrome.storage.session.get failed:", e);
      throw e;
    }
  }
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    secretsCache = parsed.filter(isValidSecretEntry);
    return secretsCache;
  } catch {
    secretsCache = [];
    return secretsCache;
  }
}

export async function setSecret(name: string, value: string): Promise<void> {
  return withSecretLock(async () => {
    const secrets = (await listSecrets()).slice();
    const idx = secrets.findIndex((s) => s.name === name);
    const entry: SecretEntry = { name, value, createdAt: Date.now() };
    if (idx >= 0) secrets[idx] = entry;
    else secrets.push(entry);
    await persist(secrets);
    secretsCache = null;
    secretSetVersion++;
  });
}

export async function deleteSecret(name: string): Promise<void> {
  return withSecretLock(async () => {
    const secrets = (await listSecrets()).filter((s) => s.name !== name);
    await persist(secrets);
    secretsCache = null;
    secretSetVersion++;
  });
}

export async function substituteSecrets(
  text: string,
  options: SubstituteSecretsOptions = {},
): Promise<string> {
  const { trusted = false } = options;
  if (!trusted) return text;
  if (!HAS_PLACEHOLDER.test(text)) return text;
  if (secretsResolvedExternally) return text;
  let secrets: SecretEntry[];
  try {
    secrets = await listSecrets();
  } catch (e) {
    console.error(
      "[secrets] substituteSecrets: could not load secrets; cannot safely substitute:",
      e,
    );
    throw e;
  }
  const artifacts = getRedactionArtifacts(secrets);
  const map = artifacts ? artifacts.nameToValue : new Map(secrets.map((s) => [s.name, s.value]));
  return text.replace(PLACEHOLDER_PATTERN, (match, name: string) => map.get(name) ?? match);
}

export async function redactSecrets(text: string): Promise<string> {
  if (secretsResolvedExternally) return text;
  let secrets: SecretEntry[];
  try {
    secrets = await listSecrets();
  } catch (e) {
    console.warn("[secrets] redactSecrets: could not load secrets; masking output:", e);
    return "[REDACTED: secret store unavailable]";
  }
  const artifacts = getRedactionArtifacts(secrets);
  if (!artifacts) return text;
  const { pattern, valueToName } = artifacts;
  pattern.lastIndex = 0;
  return text.replace(pattern, (match) => `[REDACTED:${valueToName.get(match) ?? "unknown"}]`);
}
