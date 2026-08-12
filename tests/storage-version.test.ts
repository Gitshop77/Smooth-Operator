/**
 * storage-version.ts — versioned storage markers: legacy acceptance through the
 * migration window, fail-closed rejection of future versions, and marker
 * persistence only after a successful (registered) migration.
 */

import { describe, it, expect } from "vitest";
import {
  CURRENT_STORAGE_VERSIONS,
  LEGACY_VERSION,
  STORAGE_VERSION_KEY,
  StorageVersionError,
  assertStorageVersionSupported,
  invalidateStorageVersionCache,
  isSupportedStorageVersion,
  parseStorageVersionMap,
  readStorageVersionMap,
  writeStorageVersionMap,
  type StorageVersionMap,
  type VersionStorageArea,
} from "../src/lib/agent/storage-version";

function makeArea(store: Map<string, unknown>): VersionStorageArea {
  return {
    get: async (key: string) => ({ [key]: store.get(key) }),
    set: async (items: Record<string, unknown>) => {
      Object.entries(items).forEach(([k, v]) => store.set(k, v));
    },
  };
}

const currentMap = (): StorageVersionMap => ({ ...CURRENT_STORAGE_VERSIONS });

describe("parseStorageVersionMap", () => {
  it("accepts a complete current marker", () => {
    const parsed = parseStorageVersionMap(currentMap());
    expect(parsed).toEqual(CURRENT_STORAGE_VERSIONS);
  });

  it("rejects garbage, partial, and non-object markers (treated as legacy)", () => {
    expect(parseStorageVersionMap(undefined)).toBeNull();
    expect(parseStorageVersionMap(null)).toBeNull();
    expect(parseStorageVersionMap("v1")).toBeNull();
    expect(parseStorageVersionMap(42)).toBeNull();
    expect(parseStorageVersionMap({ settings: 1, history: 1 })).toBeNull();
    expect(parseStorageVersionMap({ settings: 1, history: 1, schedules: "x" })).toBeNull();
    expect(parseStorageVersionMap({ settings: 1, history: 1, schedules: -1 })).toBeNull();
  });
});

describe("isSupportedStorageVersion", () => {
  it("accepts the current version and the legacy baseline", () => {
    for (const domain of ["settings", "history", "schedules"] as const) {
      expect(isSupportedStorageVersion(domain, CURRENT_STORAGE_VERSIONS[domain])).toBe(true);
      expect(isSupportedStorageVersion(domain, LEGACY_VERSION)).toBe(true);
    }
  });

  it("rejects future versions (fail closed)", () => {
    for (const domain of ["settings", "history", "schedules"] as const) {
      expect(isSupportedStorageVersion(domain, CURRENT_STORAGE_VERSIONS[domain] + 1)).toBe(false);
    }
  });
});

describe("readStorageVersionMap / writeStorageVersionMap", () => {
  it("returns null when unmarked (legacy) and never throws", async () => {
    const area = makeArea(new Map());
    expect(await readStorageVersionMap(area)).toBeNull();
  });

  it("round-trips a marker through the area", async () => {
    const area = makeArea(new Map());
    await writeStorageVersionMap(currentMap(), area);
    expect(await readStorageVersionMap(area)).toEqual(CURRENT_STORAGE_VERSIONS);
    expect(area.get(STORAGE_VERSION_KEY)).toBeDefined();
  });

  it("treats a garbage marker as legacy instead of crashing", async () => {
    const area = makeArea(new Map([[STORAGE_VERSION_KEY, { settings: "nope" }]]));
    expect(await readStorageVersionMap(area)).toBeNull();
  });

  it("serves a successful parse from the module cache without re-reading storage", async () => {
    const store = new Map<string, unknown>([[STORAGE_VERSION_KEY, currentMap()]]);
    let reads = 0;
    const area: VersionStorageArea = {
      get: async (key: string) => {
        reads++;
        return { [key]: store.get(key) };
      },
      set: async (items: Record<string, unknown>) => {
        Object.entries(items).forEach(([k, v]) => store.set(k, v));
      },
    };
    expect(await readStorageVersionMap(area)).toEqual(CURRENT_STORAGE_VERSIONS);
    expect(await readStorageVersionMap(area)).toEqual(CURRENT_STORAGE_VERSIONS);
    expect(reads).toBe(1); // second read was served from cache
  });

  it("invalidates the cache after a write (fresh read sees new data)", async () => {
    const store = new Map<string, unknown>();
    const area = makeArea(store);
    await writeStorageVersionMap(currentMap(), area);
    await readStorageVersionMap(area);
    const updated = currentMap();
    updated.settings = 2;
    await writeStorageVersionMap(updated, area);
    expect(await readStorageVersionMap(area)).toMatchObject({ settings: 2 });
  });

  it("never caches a parse failure (fail-closed re-read on every call)", async () => {
    let reads = 0;
    const area: VersionStorageArea = {
      get: async () => {
        reads++;
        return { [STORAGE_VERSION_KEY]: "garbage" };
      },
      set: async () => {},
    };
    expect(await readStorageVersionMap(area)).toBeNull();
    expect(await readStorageVersionMap(area)).toBeNull();
    expect(reads).toBe(2);
  });

  it("explicit invalidation forces a fresh read", async () => {
    const store = new Map<string, unknown>();
    const area = makeArea(store);
    await writeStorageVersionMap(currentMap(), area);
    await readStorageVersionMap(area);
    store.set(STORAGE_VERSION_KEY, { ...currentMap(), history: 0 });
    invalidateStorageVersionCache();
    expect((await readStorageVersionMap(area))?.history).toBe(0);
  });
});

describe("assertStorageVersionSupported", () => {
  it("passes for legacy unmarked data and for the current version", async () => {
    await assertStorageVersionSupported("history", makeArea(new Map()));
    await assertStorageVersionSupported("history", makeArea(new Map([[STORAGE_VERSION_KEY, currentMap()]])));
  });

  it("throws StorageVersionError (code STORAGE_VERSION_UNSUPPORTED) for a future version", async () => {
    const future = currentMap();
    future.history = CURRENT_STORAGE_VERSIONS.history + 1;
    const area = makeArea(new Map([[STORAGE_VERSION_KEY, future]]));
    await expect(assertStorageVersionSupported("history", area)).rejects.toMatchObject({
      code: "STORAGE_VERSION_UNSUPPORTED",
      domain: "history",
      found: CURRENT_STORAGE_VERSIONS.history + 1,
      supported: CURRENT_STORAGE_VERSIONS.history,
    });
    await expect(assertStorageVersionSupported("history", area)).rejects.toBeInstanceOf(StorageVersionError);
  });

  it("throws on a storage read failure (fail closed, never silently accept)", async () => {
    const area: VersionStorageArea = {
      get: async () => { throw new Error("storage unavailable"); },
      set: async () => {},
    };
    // A read failure surfaces the error instead of pretending the data is legacy.
    await expect(assertStorageVersionSupported("settings", area)).rejects.toThrow("storage unavailable");
  });
});
