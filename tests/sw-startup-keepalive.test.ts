/**
 * background/index.ts — SW-startup keepalive cleanup (part 1).
 *
 * `startKeepalive` is armed by `initRunState` at run start and stopped only in
 * the run stop/cleanup paths (`cleanupRun`, abort-wiring failure). If the
 * service worker is killed mid-run, the alarm persists (chrome.alarms outlive
 * the SW) and keeps firing every 15s forever, keeping the SW alive. The
 * SW-startup path (`onServiceWorkerStartup`) must clear it when no run is
 * active — both when there never was a run and when an interrupted run was
 * just detected + cleared.
 *
 * These tests import the REAL background entry module so the top-level
 * `void onServiceWorkerStartup()` executes, and assert on the recorded
 * chrome.alarms calls.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

const KEEPALIVE_ALARM = "open_cowork_keepalive";
const RUN_STATE_KEY = "open_cowork_run_state";
const LAST_RUN_SNAPSHOT_KEY = "open_cowork_run_snapshot_v1";

let alarms: {
  created: Array<{ name: string; spec?: chrome.alarms.AlarmCreateInfo }>;
  cleared: string[];
};
let sessionStore: Record<string, unknown>;
let localStore: Record<string, unknown>;
let contentMessages: Array<{ tabId: number; message: unknown }>;

function installChromeStub(): void {
  alarms = { created: [], cleared: [] };
  sessionStore = {};
  localStore = {};
  contentMessages = [];
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      id: "test-extension-id",
      onMessage: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      onConnect: { addListener: vi.fn() },
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
    storage: {
      local: {
        get: vi.fn(async (key: unknown) => {
          if (typeof key === "string") return { [key]: localStore[key] };
          if (Array.isArray(key)) {
            const out: Record<string, unknown> = {};
            for (const k of key) out[k] = localStore[k];
            return out;
          }
          return { ...localStore };
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(localStore, items);
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete localStore[k];
        }),
      },
      session: {
        setAccessLevel: vi.fn(async () => undefined),
        get: vi.fn(async (key: unknown) => {
          if (typeof key === "string") return { [key]: sessionStore[key] };
          if (Array.isArray(key)) {
            const out: Record<string, unknown> = {};
            for (const k of key) out[k] = sessionStore[k];
            return out;
          }
          return { ...sessionStore };
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(sessionStore, items);
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete sessionStore[k];
        }),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    alarms: {
      create: vi.fn(async (name: string, spec?: chrome.alarms.AlarmCreateInfo) => {
        alarms.created.push({ name, spec });
      }),
      clear: vi.fn(async (name: string) => {
        alarms.cleared.push(name);
        return true;
      }),
      get: vi.fn(),
      getAll: vi.fn(),
      onAlarm: { addListener: vi.fn() },
    },
    webRequest: {
      onCompleted: { addListener: vi.fn() },
    },
    tabs: {
      onRemoved: { addListener: vi.fn() },
      query: vi.fn(async () => [{ id: 7, url: "https://example.test/" }]),
      sendMessage: vi.fn(async (tabId: number, message: unknown) => {
        contentMessages.push({ tabId, message });
        return { ok: true };
      }),
    },
    power: {
      requestKeepAwake: vi.fn(),
      releaseKeepAwake: vi.fn(),
    },
    sidePanel: {
      setPanelBehavior: vi.fn().mockResolvedValue(undefined),
      open: vi.fn().mockResolvedValue(undefined),
    },
    commands: {
      onCommand: { addListener: vi.fn() },
    },
    action: {
      onClicked: { addListener: vi.fn() },
      setBadgeText: vi.fn(),
      setBadgeBackgroundColor: vi.fn(),
    },
    notifications: {
      create: vi.fn(),
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe("SW startup — keepalive alarm cleanup", () => {
  beforeEach(() => {
    vi.resetModules();
    installChromeStub();
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).chrome;
  });

  test("startup with no active run clears the keepalive alarm (leak from an interrupted run)", async () => {
    // Simulate a leaked alarm left behind by a run whose SW died mid-run:
    // no run state persisted (already cleared), but the alarm still exists.
    alarms.created.push({ name: KEEPALIVE_ALARM, spec: { periodInMinutes: 0.25 } });

    await import("../src/extension/background/index");
    await flush();

    expect(chrome.storage.session.setAccessLevel).toHaveBeenCalledWith({
      accessLevel: "TRUSTED_CONTEXTS",
    });

    // The leaked keepalive must be cleared — it must NOT keep firing + keeping
    // the SW alive indefinitely after the run is gone.
    expect(alarms.cleared).toContain(KEEPALIVE_ALARM);
    // And startup must not re-arm it (no run is active to keep alive).
    expect(alarms.created.filter((c) => c.name === KEEPALIVE_ALARM)).toHaveLength(1);
  });

  test("startup with an interrupted run (state active) clears keepalive after clearRunState", async () => {
    sessionStore[RUN_STATE_KEY] = {
      task: "t", maxSteps: 10, mode: "standard",
      startTabId: 1, currentTabId: 1, step: 3, active: true, abortRequested: false,
    };
    alarms.created.push({ name: KEEPALIVE_ALARM, spec: { periodInMinutes: 0.25 } });

    await import("../src/extension/background/index");
    await flush();

    // The interrupted run was detected → state cleared.
    expect(sessionStore[RUN_STATE_KEY]).toBeUndefined();
    // The keepalive of the dead run must not survive the restart.
    expect(alarms.cleared).toContain(KEEPALIVE_ALARM);
  });

  test("recovers an orphaned starting snapshot written before RunState initialization", async () => {
    // This is the narrow crash window between startRun's initial snapshot and
    // initRunState. There is no state record to clear, but the snapshot must
    // never remain dispatch-looking after a fresh worker starts.
    sessionStore[LAST_RUN_SNAPSHOT_KEY] = {
      version: 1,
      runId: "orphan-start",
      revision: 1,
      dispatchRevision: 1,
      task: "open a site",
      maxSteps: 10,
      mode: "standard",
      status: "starting",
      phase: "starting",
      step: 0,
      startedAt: 1,
      updatedAt: 1,
    };

    await import("../src/extension/background/index");
    await flush();

    expect(sessionStore[LAST_RUN_SNAPSHOT_KEY]).toMatchObject({
      runId: "orphan-start",
      task: "open a site",
      status: "interrupted",
      terminalReason: "interrupted",
    });
    expect(sessionStore[RUN_STATE_KEY]).toBeUndefined();
    expect(contentMessages).toContainEqual({
      tabId: 7,
      message: { type: "CANCEL_RUN", token: { runId: "orphan-start", dispatchRevision: 2 } },
    });
  });

  test("keeps the recovery gate rejected when session authority cannot be audited", async () => {
    const failure = new Error("session read failed");
    const sessionGet = chrome.storage.session.get as ReturnType<typeof vi.fn>;
    sessionGet.mockImplementation(async (key: unknown) => {
      // Startup first reads the API-key/secret redaction inputs. Fail the
      // distinct RunState authority read so this remains a recovery-gate test.
      if (key === RUN_STATE_KEY) throw failure;
      if (typeof key === "string") return { [key]: sessionStore[key] };
      if (Array.isArray(key)) {
        const out: Record<string, unknown> = {};
        for (const k of key) out[k] = sessionStore[k];
        return out;
      }
      return { ...sessionStore };
    });

    await import("../src/extension/background/index");
    const { waitForRunRecoveryAudit } = await import("../src/extension/background/run-recovery-gate");
    await expect(waitForRunRecoveryAudit()).rejects.toBe(failure);
    // Independent startup housekeeping still ran even though new run
    // admission remains fail-closed for this worker incarnation.
    expect(alarms.cleared).toContain(KEEPALIVE_ALARM);
  });
});
