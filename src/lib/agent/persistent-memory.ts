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
const STORAGE_KEY = "__opencowork_site_memories";

// Module-level cache. `getMemoriesForUrl` is called on every navigator step;
// without caching, each step does a fresh chrome.storage.local round-trip.
// Invalidated by `chrome.storage.onChanged` + every write.
let memoriesCache: Record<string, SiteMemory> | null = null;

if (isExtensionWithLocal() && typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY]) {
      memoriesCache = null;
    }
  });
}

/** Test-only: clear the in-memory cache so the next read goes back to storage. */
export function __resetMemoryCacheForTests(): void {
  memoriesCache = null;
}

/**
 * Per-context mutex mirroring `withTaskMutation` in `scheduled-tasks.ts`.
 *
 * `chrome.storage.local` has no transactions, so a read-modify-write of the
 * memory map can interleave with another mutation in the *same* context and
 * clobber it (lost-update race — see audit batch b026). On a cold cache two
 * concurrent `saveMemory`/`deleteMemory` calls can both read the same stored
 * map, mutate independent copies, and the last writer silently wins — a user
 * memory edit is lost. This serializes each mutation's load→mutate→write.
 *
 * It cannot prevent a race with a separate JS context (e.g. the Options page);
 * fixing that would require per-domain storage keys, which is out of scope here.
 */
let memoryMutationLock: Promise<void> = Promise.resolve();
async function withMemoryMutation<T>(fn: () => Promise<T>): Promise<T> {
  const prev = memoryMutationLock;
  let release!: () => void;
  memoryMutationLock = new Promise<void>((r) => (release = r));
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Normalize a stored value into a `{ domain -> SiteMemory }` map. Guards
 * against type-mismatched / corrupt storage (a non-object or array value
 * under the key) so callers don't throw on `Object.values` / `for..in`
 * downstream. Returns an empty object when the value isn't a non-null,
 * non-array object.
 */
function normalizeMemoryMap(raw: unknown): Record<string, SiteMemory> {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, SiteMemory>)
    : {};
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
      `[${neutralizePromptTags(m.domain).replace(/<\/site_memory>/gi, "<\\/site_memory>")}]: ${neutralizePromptTags(m.notes).replace(/<\/site_memory>/gi, "<\\/site_memory>")}`,
  );
  return `<site_memory>\n${lines.join("\n")}\n</site_memory>`;
}
