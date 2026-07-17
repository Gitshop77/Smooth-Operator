/**
 * state-store.ts — saveRunState abort-merge + write serialization.
 *
 * Pin the two non-trivial guarantees in saveRunState:
 *  1. a STOP (abortRequested) write is never clobbered by a concurrent step write.
 *  2. overlapping saveRunState calls serialize their read-modify-write so both
 *     merged fields survive.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  saveRunState,
  getRunState,
  clearRunState,
  loadAndSetDomainConfig,
  RUN_STATE_KEY,
  type RunState,
} from "../src/extension/background/state-store";
import { initRunState } from "../src/extension/background/run-helpers";
import { checkUrlAllowedWithDomainConfig } from "../src/lib/agent/tools/helpers/domain-config";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function installSessionStub() {
  const store: Record<string, unknown> = {};
  const chrome = {
    storage: {
      session: {
        get: vi.fn(async (key: unknown) => {
          await delay(2);
          if (typeof key === "string") return { [key]: store[key] };
          if (Array.isArray(key)) {
            const out: Record<string, unknown> = {};
            for (const k of key) out[k] = store[k];
            return out;
          }
          return { ...store };
        }),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          await delay(2);
          Object.assign(store, obj);
        }),
        remove: vi.fn(async (key: string) => {
          delete store[key];
        }),
      },
    },
    alarms: {
      create: vi.fn(),
      clear: vi.fn(),
    },
  };
  (globalThis as Record<string, unknown>).chrome = chrome;
  return { store, chrome };
}

const baseState = (): RunState => ({
  task: "t",
  maxSteps: 1,
  mode: "standard",
  startTabId: 1,
  currentTabId: 1,
  step: 0,
  active: true,
  abortRequested: false,
});

let restore: () => void;

beforeEach(() => {
  const { store } = installSessionStub();
  store[RUN_STATE_KEY] = baseState();
  restore = () => {
    delete (globalThis as Record<string, unknown>).chrome;
  };
});

afterEach(() => {
  restore();
});

describe("saveRunState abort merge", () => {
  test("abortRequested survives a concurrent step save", async () => {
    const stepSave = saveRunState({ step: 5 });
    const abortSave = saveRunState({ abortRequested: true });
    await Promise.all([stepSave, abortSave]);
    const st = await getRunState();
    expect(st?.abortRequested).toBe(true);
    expect(st?.step).toBe(5);
  });

  test("a STOP after a step write keeps abortRequested true", async () => {
    await saveRunState({ step: 3 });
    await saveRunState({ abortRequested: true });
    const st = await getRunState();
    expect(st?.abortRequested).toBe(true);
    expect(st?.step).toBe(3);
  });
});

describe("saveRunState write serialization", () => {
  test("two overlapping saves both merge (no lost field)", async () => {
    const a = saveRunState({ step: 10 });
    const b = saveRunState({ mode: "restricted" as RunState["mode"] });
    await Promise.all([a, b]);
    const st = await getRunState();
    expect(st?.step).toBe(10);
    expect(st?.mode).toBe("restricted");
  });

  test("clearRunState removes the persisted state", async () => {
    await clearRunState();
    expect(await getRunState()).toBeNull();
  });
});

describe("initRunState abort-merge preservation", () => {
  test("a concurrent STOP (abortRequested:true) survives a fresh init write", async () => {
    const { store, chrome } = installSessionStub();
    store[RUN_STATE_KEY] = { ...baseState(), active: true, abortRequested: true };
    let keepaliveCalled = false;
    chrome.alarms.create = vi.fn(() => {
      keepaliveCalled = true;
    });
    // A fresh run-state arrives asserting abortRequested:false. It must NOT
    // clobber a STOP that landed between the RUN handler's sendResponse and
    // this call (the TOCTOU the guard exists for).
    await initRunState(baseState());
    const st = await getRunState();
    expect(st?.abortRequested).toBe(true);
    expect(st?.active).toBe(true);
    expect(keepaliveCalled).toBe(true);
  });
});

describe("loadAndSetDomainConfig fail-closed", () => {
  test("storage failure throws, flags enforcement, and the live gate blocks", async () => {
    const chrome = {
      storage: {
        local: {
          get: vi.fn(async () => {
            throw new Error("storage unavailable");
          }),
        },
      },
    };
    const chromeRef = chrome as unknown as Record<string, unknown>;
    (globalThis as Record<string, unknown>).chrome = chromeRef;
    delete (globalThis as Record<string, unknown>).__openCoworkDomainConfig;
    delete (globalThis as Record<string, unknown>).__openCoworkDomainConfigEnforced;

    await expect(loadAndSetDomainConfig()).rejects.toThrow();

    // Fail-closed posture: enforcement flagged, cached config cleared.
    expect(
      (globalThis as Record<string, unknown>).__openCoworkDomainConfigEnforced,
    ).toBe(true);
    expect(
      (globalThis as Record<string, unknown>).__openCoworkDomainConfig,
    ).toBeUndefined();

    // The live policy gate now blocks any navigation rather than allow-all.
    const res = checkUrlAllowedWithDomainConfig("https://example.com/anything");
    expect(res.allowed).toBe(false);

    delete (globalThis as Record<string, unknown>).chrome;
    delete (globalThis as Record<string, unknown>).__openCoworkDomainConfig;
    delete (globalThis as Record<string, unknown>).__openCoworkDomainConfigEnforced;
  });

  test("a loaded allowlist is consulted and an off-allowlist host blocks", async () => {
    const chrome = {
      storage: {
        local: {
          get: vi.fn(async () => ({
            allowedDomains: ["allowed.example"],
            blockedDomains: [],
          })),
        },
      },
    };
    (globalThis as Record<string, unknown>).chrome = chrome as unknown as Record<string, unknown>;

    const cfg = await loadAndSetDomainConfig();
    expect(cfg.allowedDomains).toEqual(["allowed.example"]);

    expect(
      checkUrlAllowedWithDomainConfig("https://allowed.example/page").allowed,
    ).toBe(true);
    expect(
      checkUrlAllowedWithDomainConfig("https://evil.example/page").allowed,
    ).toBe(false);

    delete (globalThis as Record<string, unknown>).chrome;
    delete (globalThis as Record<string, unknown>).__openCoworkDomainConfig;
    delete (globalThis as Record<string, unknown>).__openCoworkDomainConfigEnforced;
  });
});
