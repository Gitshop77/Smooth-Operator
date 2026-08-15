/**
 * storage-version.ts — explicit storage-version markers for the persistence
 * domains owned by the background (settings, run history, scheduled tasks).
 *
 * Background-owned persistence needs a versioning scheme so a future reader
 * never mis-parses data written by a newer extension, and so a future writer
 * can migrate old data with a registered, reversible plan. This module owns
 * the markers only — the data records themselves keep their existing shapes
 * (original values are retained until a registered migration succeeds).
 *
 * Semantics:
 * - The marker lives under one chrome.storage.local key
 *   (`open_cowork_storage_version`) and maps each domain to its data version.
 * - An ABSENT marker is the legacy baseline: every domain is implicitly
 *   version 0, which all current readers accept through the migration window.
 * - A marker reporting a FUTURE version for any domain fails closed: readers
 *   must refuse to interpret data they do not understand (never emit garbage).
 * - Readers accept the current version plus any version listed as previous-
 *   supported for that domain (the migration window).
 *
 * The migration register is the authoritative ledger; a marker bump must
 * always be registered there first.
 */

/** chrome.storage.local key holding the version marker map. */
export const STORAGE_VERSION_KEY = "open_cowork_storage_version";

/** Persistence domains with background-owned version markers. */
export type StorageDomain = "settings" | "history" | "schedules";

/** Marker shape: one explicit integer version per domain. */
export interface StorageVersionMap {
  settings: number;
  history: number;
  schedules: number;
}

/** Current data versions. Bump only via a registered, reversible migration. */
export const CURRENT_STORAGE_VERSIONS: StorageVersionMap = {
  settings: 1,
  history: 1,
  schedules: 1,
};

/**
 * Versions still readable during an active migration window, per domain.
 * The implicit legacy baseline (no marker at all) is version 0 and is always
 * accepted; a version listed here is accepted only while its migration is in
 * flight and must be removed from this table when the migration closes.
 */
const PREVIOUS_SUPPORTED_VERSIONS: Record<StorageDomain, readonly number[]> = {
  settings: [0],
  history: [0],
  schedules: [0],
};

/** Implicit version of an unmarked (legacy) record set. */
export const LEGACY_VERSION = 0;

/** Thrown when stored data claims a version newer than this build supports. */
export class StorageVersionError extends Error {
  readonly code = "STORAGE_VERSION_UNSUPPORTED";

  constructor(
    readonly domain: StorageDomain,
    readonly found: number,
    readonly supported: number,
  ) {
    super(
      `Storage for "${domain}" is version ${found}, but this build supports ` +
      `at most version ${supported}; refusing to read or mutate it (fail closed).`,
    );
    this.name = "StorageVersionError";
  }
}

/** True when a version is the current one or is inside the migration window. */
export function isSupportedStorageVersion(domain: StorageDomain, version: number): boolean {
  if (version === CURRENT_STORAGE_VERSIONS[domain]) return true;
  return PREVIOUS_SUPPORTED_VERSIONS[domain].includes(version);
}

/**
 * Parse + validate a raw stored marker. Returns `null` for an absent or
 * partial/garbage marker, which callers must treat as the legacy baseline
 * (version 0 everywhere) — a partial marker is never trusted as authoritative.
 */
export function parseStorageVersionMap(raw: unknown): StorageVersionMap | null {
  if (raw === null || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const out: Partial<StorageVersionMap> = {};
  for (const domain of Object.keys(CURRENT_STORAGE_VERSIONS) as StorageDomain[]) {
    const v = m[domain];
    if (!Number.isSafeInteger(v) || (v as number) < 0) return null;
    out[domain] = v as number;
  }
  return { settings: out.settings!, history: out.history!, schedules: out.schedules! };
}

/** Minimal storage-area surface this module needs (chrome.storage.local shape). */
export interface VersionStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** Default chrome.storage.local adapter; throws outside an extension context. */
function defaultArea(): VersionStorageArea {
  const local = (globalThis as { chrome?: { storage?: { local?: VersionStorageArea } } }).chrome?.storage?.local;
  if (!local) throw new Error("chrome.storage.local is unavailable");
  return local;
}

/**
 * Read the persisted marker; `null` means legacy/unmarked. A storage read
 * failure PROPAGATES (fail closed) — a transient read error must never be
 * mistaken for the legacy baseline, which would silently admit data a newer
 * build wrote.
 *
 * Successful parses are cached module-wide keyed by the storage-area instance
 * (the marker is immutable except via {@link writeStorageVersionMap}) and
 * invalidated by `chrome.storage.onChanged` for {@link STORAGE_VERSION_KEY} or
 * after a write, so the pre-read of every background domain access is a memory
 * hit. Parse FAILURES are never cached — the fail-closed propagation stays
 * intact.
 */
let cachedVersionEntry: { area: VersionStorageArea; map: StorageVersionMap | null } | undefined;

/** Drop the cached marker (after a write or an external storage change). */
export function invalidateStorageVersionCache(): void {
  cachedVersionEntry = undefined;
}

if (
  typeof globalThis !== "undefined" &&
  (globalThis as { chrome?: { storage?: { onChanged?: { addListener: (cb: (c: unknown, a: string) => void) => void } } } }).chrome?.storage?.onChanged
) {
  (globalThis as {
    chrome?: { storage?: { onChanged?: { addListener: (cb: (c: { [k: string]: { newValue?: unknown } }, a: string) => void) => void } } };
  }).chrome!.storage!.onChanged!.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_VERSION_KEY]) {
      cachedVersionEntry = undefined;
    }
  });
}

export async function readStorageVersionMap(
  area: VersionStorageArea = defaultArea(),
): Promise<StorageVersionMap | null> {
  if (cachedVersionEntry?.area === area) return cachedVersionEntry.map;
  const res = await area.get(STORAGE_VERSION_KEY);
  const parsed = parseStorageVersionMap(res[STORAGE_VERSION_KEY]);
  if (parsed !== null) cachedVersionEntry = { area, map: parsed };
  return parsed;
}

/** Persist a full marker map. Call only after the registered migration succeeded. */
export async function writeStorageVersionMap(
  map: StorageVersionMap,
  area: VersionStorageArea = defaultArea(),
): Promise<void> {
  await area.set({ [STORAGE_VERSION_KEY]: { ...map } });
  cachedVersionEntry = { area, map: { ...map } };
}

/**
 * Fail-closed gate: throws {@link StorageVersionError} when the stored marker
 * claims a version this build cannot read for `domain`. Absent markers (legacy)
 * and current/migration-window versions pass. Call before any background read
 * or mutation of a domain's records.
 */
export async function assertStorageVersionSupported(
  domain: StorageDomain,
  area: VersionStorageArea = defaultArea(),
): Promise<void> {
  const map = await readStorageVersionMap(area);
  if (map === null) return; // legacy unmarked — accepted through the migration window
  const found = map[domain];
  if (!isSupportedStorageVersion(domain, found)) {
    throw new StorageVersionError(domain, found, CURRENT_STORAGE_VERSIONS[domain]);
  }
}
