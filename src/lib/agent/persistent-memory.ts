/**
 * Per-site persistent memory — user-defined notes per domain, injected as
 * trusted context (`<site_memory>`) into the navigator prompt.
 *
 * The navigator message builder calls {@link getMemoriesForUrl} every step;
 * {@link formatMemories} renders the results as a `<site_memory>` block. The
 * block is NOT wrapped in `wrapUntrusted` — these are user-authored notes
 * (same trust level as `<user_request>`).
 *
 * Writes go through {@link saveMemory} / {@link deleteMemory}. The options
 * page can expose a memory-editing UI; today the API is used by tests.
 */

import { isExtensionWithLocal } from "./runtime";
import { neutralizePromptTags } from "./security";
import { createMutex } from "./mutex";

/**
 * Sanitize user-authored memory text before injecting it into the trusted
 * system prompt. Applies the same dual-layer defense as `sanitizeSkillText`
 * in domain-skills.ts:
 * 1. Strip control characters (obfuscation / rendering corruption).
 * 2. Neutralize forged `<system-reminder>` tags (explicit boundary defense).
 * 3. Neutralize ALL prompt-level tags via `neutralizePromptTags` (derived from
 *    PROMPT_TAGS — the single source of truth).
 *
 * This provides defense-in-depth: if `neutralizePromptTags` has a gap,
 * layers 1–2 still block the most common injection vectors.
 */
function sanitizeMemoryText(value: string): string {
  const cleaned = value
    // Strip C0/C1 control chars except tab, newline, carriage return.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u00ad\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    // Neutralize forged system-reminder open/close tags.
    .replace(/<(\/?\s*system-reminder\b[^>]*)>/gi, "[$1]");
  return neutralizePromptTags(cleaned);
}

/** One saved memory for a single root domain. */
export interface SiteMemory {
  /** Root domain (e.g. "github.com"). Stored as the key. */
  domain: string;
  /** Free-text memory notes (one per line, or a single sentence). */
  notes: string;
  /** Unix ms timestamp when this memory was last updated. */
  updatedAt: number;
}

/** Storage key under which the whole `{ domain -> SiteMemory }` map is persisted. */
const STORAGE_KEY = "open_cowork_site_memories";

// Module-level cache. `getMemoriesForUrl` is called on every navigator step;
// without caching, each step does a fresh chrome.storage.local round-trip.
// Invalidated by `chrome.storage.onChanged` + every write.
let memoriesCache: Record<string, SiteMemory> | null = null;

// Hostname-level cache for `getMemoriesForUrl`. Maps hostname → matching
// memories so repeated steps on the same site skip the full linear scan.
// Invalidated whenever the raw memories cache changes.
let hostnameMemoriesCache: { hostname: string; memories: SiteMemory[] } | null = null;

if (isExtensionWithLocal() && typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY]) {
      memoriesCache = null;
      hostnameMemoriesCache = null;
    }
  });
}

// The localStorage (demo / non-extension) path has no chrome.storage events;
// a write from another tab fires a `storage` event instead. Without this
// listener the second tab would keep serving a stale cache.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY) {
      memoriesCache = null;
      hostnameMemoriesCache = null;
    }
  });
}

/** Test-only: clear the in-memory cache so the next read goes back to storage. */
export function __resetMemoryCacheForTests(): void {
  memoriesCache = null;
  hostnameMemoriesCache = null;
}

const withMemoryMutation = createMutex();

/**
 * Normalize a stored value into a `{ domain -> SiteMemory }` map. Guards
 * against type-mismatched / corrupt storage (a non-object or array value
 * under the key) so callers don't throw on `Object.values` / `for..in`
 * downstream. Returns an empty object when the value isn't a non-null,
 * non-array object.
 */
function normalizeMemoryMap(raw: unknown): Record<string, SiteMemory> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, SiteMemory> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const domain = typeof v.domain === "string" && v.domain.length > 0 ? v.domain : key;
    if (typeof domain !== "string" || domain.length === 0) continue;
    const notes = typeof v.notes === "string" ? v.notes : "";
    const updatedAt =
      typeof v.updatedAt === "number" && Number.isFinite(v.updatedAt)
        ? v.updatedAt
        : Date.now();
    out[key] = { domain, notes, updatedAt };
  }
  return out;
}

/**
 * Load the full map of `{ domain -> SiteMemory }` from storage.
 * Returns an empty object on any storage / parse error.
 */
export async function loadAllMemories(): Promise<Record<string, SiteMemory>> {
  if (memoriesCache !== null) return memoriesCache;
  if (isExtensionWithLocal()) {
    try {
      const res = await chrome.storage.local.get(STORAGE_KEY);
      const raw = res[STORAGE_KEY];
      const map = normalizeMemoryMap(raw);
      memoriesCache = map;
      return map;
    } catch {
      return {};
    }
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const map = normalizeMemoryMap(parsed);
    memoriesCache = map;
    return map;
  } catch {
    return {};
  }
}

/** Internal: persist the full memory map back to storage + invalidate cache. */
async function writeAllMemories(all: Record<string, SiteMemory>): Promise<void> {
  memoriesCache = null;
  hostnameMemoriesCache = null;
  if (isExtensionWithLocal()) {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: all });
    } catch {
      /* best-effort */
    }
  } else {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch {
      /* quota / disabled storage */
    }
  }
}

/**
 * Save (or replace) a site memory for `domain`. Empty notes DELETE the entry.
 */
export async function saveMemory(domain: string, notes: string): Promise<void> {
  const d = domain.trim().toLowerCase();
  if (!d) return;
  await withMemoryMutation(async () => {
    const all = { ...(await loadAllMemories()) };
    if (!notes.trim()) {
      delete all[d];
    } else {
      all[d] = { domain: d, notes: notes.trim(), updatedAt: Date.now() };
    }
    await writeAllMemories(all);
  });
}

/** Delete a site memory by domain. No-op if the domain isn't stored. */
export async function deleteMemory(domain: string): Promise<void> {
  const d = domain.trim().toLowerCase();
  if (!d) return;
  await withMemoryMutation(async () => {
    const all = { ...(await loadAllMemories()) };
    if (!(d in all)) return;
    delete all[d];
    await writeAllMemories(all);
  });
}

/**
 * Get all memories matching a URL — by exact hostname or root-domain suffix.
 *
 * Example: `https://gist.github.com/foo` matches a memory stored under
 * `github.com` (suffix match `gist.github.com` ends with `.github.com`).
 * Returns an empty array on any URL parse error.
 */
export async function getMemoriesForUrl(url: string): Promise<SiteMemory[]> {
  const all = await loadAllMemories();
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return [];
  }
  if (!hostname) return [];
  // Return cached result if the same hostname was queried recently.
  if (hostnameMemoriesCache?.hostname === hostname) {
    return hostnameMemoriesCache.memories;
  }
  const matches: SiteMemory[] = [];
  for (const memory of Object.values(all)) {
    const d = memory.domain.toLowerCase();
 // Exact-hostname match always applies. Suffix matching (`.${d}`) is only
 // safe for a real domain (one containing a dot): a bare TLD like `com`
 // would otherwise match EVERY `.com` host via `.endsWith(".com")` and
 // inject that memory site-wide. Bare-TLD entries can therefore only be
 // matched by exact hostname equality.
    if (hostname === d || (d.includes(".") && hostname.endsWith("." + d))) {
      matches.push(memory);
    }
  }
  matches.sort((a, b) => a.domain.localeCompare(b.domain));
  hostnameMemoriesCache = { hostname, memories: matches };
  return matches;
}

/**
 * Format memories as a `<site_memory>` prompt block. Returns `""` when empty
 * (so the navigator message builder can `${formatMemories(...)}` without
 * emitting an empty tag).
 */
export function formatMemories(memories: SiteMemory[]): string {
  if (memories.length === 0) return "";
  const lines = memories.map(
    (m) =>
      `[${sanitizeMemoryText(m.domain)}]: ${sanitizeMemoryText(m.notes)}`,
  );
  return `<site_memory>\n${lines.join("\n")}\n</site_memory>`;
}
