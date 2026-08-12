import { isExtensionWithSession } from "./runtime";
import type { SecretEntry, SubstituteSecretsOptions } from "./secrets-utils";
import {
  PLACEHOLDER_PATTERN,
  HAS_PLACEHOLDER,
  isValidSecretEntry,
  buildRedactionArtifacts,
} from "./secrets-utils";
import { redactKeyLeak } from "./redact-shared";

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

/**
 * Synchronous redactor for values about to cross a live boundary (runtime
 * messages, controller snapshots, provider diagnostics). `redactSecrets()`
 * cannot be used there because reading extension storage is asynchronous: by
 * the time it resolves the value may already have reached the side panel.
 *
 * This cache is deliberately memory-only. In particular, a provider API key
 * is retained only for the active worker lifetime and is never copied back to
 * storage by this redaction path.
 */
let liveRedactionCache: {
  secretSetVersion: number;
  artifacts: ReturnType<typeof buildRedactionArtifacts>;
} | null = null;
let liveRedactionEpoch = 0;
let liveRedactionState: "unprimed" | "ready" | "failed" = "unprimed";

export const LIVE_REDACTION_UNAVAILABLE = "[REDACTED: live secret redaction unavailable]";

export function invalidateLiveSecretRedaction(): void {
  liveRedactionEpoch++;
  liveRedactionCache = null;
  liveRedactionState = "failed";
}

/**
 * Prime the exact-value cache before a run starts or a provider is built.
 * Failure is intentionally absorbed: the synchronous consumer observes an
 * unavailable cache and masks every string instead of emitting it raw.
 */
export async function primeLiveSecretRedaction(providerApiKey = ""): Promise<void> {
  const epoch = ++liveRedactionEpoch;
  try {
    const secrets = await listSecrets();
    const entries = providerApiKey
      ? [...secrets, { name: "provider_api_key", value: providerApiKey, createdAt: 0 }]
      : secrets;
    const artifacts = buildRedactionArtifacts(entries);
    if (epoch === liveRedactionEpoch) {
      liveRedactionCache = { secretSetVersion, artifacts };
      liveRedactionState = "ready";
    }
  } catch {
    if (epoch === liveRedactionEpoch) {
      liveRedactionCache = null;
      liveRedactionState = "failed";
    }
  }
}

/**
 * Redact a string synchronously at a live trust boundary. An unprimed, stale,
 * or failed cache is not safe to use for exact-value redaction, so output is
 * fully masked rather than falling back to heuristic-only redaction.
 */
export function redactLiveSecretValue(value: string): string {
  const cache = liveRedactionCache;
  if (!cache || cache.secretSetVersion !== secretSetVersion) {
    return LIVE_REDACTION_UNAVAILABLE;
  }
  const { artifacts } = cache;
  if (!artifacts) return redactKeyLeak(value);
  artifacts.pattern.lastIndex = 0;
  const exactRedacted = value.replace(
    artifacts.pattern,
    (match) => `[REDACTED:${artifacts.valueToName.get(match) ?? "unknown"}]`,
  );
  return redactKeyLeak(exactRedacted);
}

/**
 * Provider transport is also used by isolated connection diagnostics before a
 * run has a credential cache to prime. It may retain only heuristic-redacted
 * text in that bootstrap case; once priming or invalidation has happened it
 * uses the same fail-closed exact-value policy as every other live boundary.
 */
export function redactProviderErrorPreview(value: string): string {
  return liveRedactionState === "unprimed" ? redactKeyLeak(value) : redactLiveSecretValue(value);
}

/** Test-only reset for deterministic cache-state coverage. */
export function resetLiveSecretRedactionForTests(): void {
  liveRedactionCache = null;
  liveRedactionEpoch = 0;
  liveRedactionState = "unprimed";
}

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
      console.error(`[secrets] chrome.storage.session.set failed: ${redactKeyLeak(String(e))}`);
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
        console.error(`[secrets] localStorage quota exceeded: ${redactKeyLeak(String(e))}`);
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
      invalidateLiveSecretRedaction();
    }
    // API keys may be session-only or an explicitly remembered local value.
    // Either update invalidates the ephemeral exact-value cache; until the
    // next prime, every live string is masked rather than risking the new key.
    if ((area === "session" || area === "local") && changes.apiKey) {
      invalidateLiveSecretRedaction();
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
      console.error(`[secrets] chrome.storage.session.get failed: ${redactKeyLeak(String(e))}`);
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
    invalidateLiveSecretRedaction();
  });
}

export async function deleteSecret(name: string): Promise<void> {
  return withSecretLock(async () => {
    const secrets = (await listSecrets()).filter((s) => s.name !== name);
    await persist(secrets);
    secretsCache = null;
    secretSetVersion++;
    invalidateLiveSecretRedaction();
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
    console.error(`[secrets] substituteSecrets: could not load secrets; cannot safely substitute: ${redactKeyLeak(String(e))}`);
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
    console.warn(`[secrets] redactSecrets: could not load secrets; masking output: ${redactKeyLeak(String(e))}`);
    return "[REDACTED: secret store unavailable]";
  }
  const artifacts = getRedactionArtifacts(secrets);
  if (!artifacts) return text;
  const { pattern, valueToName } = artifacts;
  pattern.lastIndex = 0;
  return text.replace(pattern, (match) => `[REDACTED:${valueToName.get(match) ?? "unknown"}]`);
}
