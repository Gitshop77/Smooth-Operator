import { describe, it, expect, beforeEach } from "vitest";
import { makeChromeStorageMock } from "./helpers/chrome-storage-mock";
import {
  readLightpandaSettings,
  LIGHTPANDA_DEFAULTS,
  LIGHTPANDA_STORAGE_KEYS,
} from "../src/extension/lightpanda-settings";

function installStorage(localStore: Map<string, unknown>): void {
  (globalThis as Record<string, unknown>).chrome = makeChromeStorageMock(localStore, new Map());
}

beforeEach(() => {
  delete (globalThis as Record<string, unknown>).chrome;
});

describe("readLightpandaSettings", () => {
  it("returns defaults when nothing is stored", async () => {
    installStorage(new Map());
    expect(await readLightpandaSettings()).toEqual(LIGHTPANDA_DEFAULTS);
  });
  it("returns stored overrides", async () => {
    const local = new Map<string, unknown>([
      [LIGHTPANDA_STORAGE_KEYS.enabled, false],
      [LIGHTPANDA_STORAGE_KEYS.binaryPath, "/opt/lightpanda"],
      [LIGHTPANDA_STORAGE_KEYS.braveKey, "b"],
      [LIGHTPANDA_STORAGE_KEYS.tavilyKey, "t"],
      [LIGHTPANDA_STORAGE_KEYS.timeoutSeconds, 300],
      [LIGHTPANDA_STORAGE_KEYS.maxResultChars, 64000],
    ]);
    installStorage(local);
    const s = await readLightpandaSettings();
    expect(s.enabled).toBe(false);
    expect(s.binaryPath).toBe("/opt/lightpanda");
    expect(s.braveKey).toBe("b");
    expect(s.tavilyKey).toBe("t");
    expect(s.timeoutMs).toBe(300_000);
    expect(s.maxResultChars).toBe(64_000);
  });
  it("clamps timeout to 600s and maxResultChars to 128k", async () => {
    installStorage(new Map<string, unknown>([
      [LIGHTPANDA_STORAGE_KEYS.timeoutSeconds, 9999],
      [LIGHTPANDA_STORAGE_KEYS.maxResultChars, 999_999_999],
    ]));
    const s = await readLightpandaSettings();
    expect(s.timeoutMs).toBe(600_000);
    expect(s.maxResultChars).toBe(128_000);
  });
  it("falls back to defaults for garbage values", async () => {
    installStorage(new Map<string, unknown>([
      [LIGHTPANDA_STORAGE_KEYS.timeoutSeconds, "nope"],
      [LIGHTPANDA_STORAGE_KEYS.maxResultChars, -5],
    ]));
    const s = await readLightpandaSettings();
    expect(s.timeoutMs).toBe(LIGHTPANDA_DEFAULTS.timeoutMs);
    expect(s.maxResultChars).toBe(LIGHTPANDA_DEFAULTS.maxResultChars);
  });
});
