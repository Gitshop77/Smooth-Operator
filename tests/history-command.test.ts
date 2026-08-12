/**
 * history-command.ts + run-history.ts mergeRuns — background-owned history
 * commands: sender gating, redacted export, revision-guarded import, concurrent
 * mutation safety, and quota/corruption fail-closed behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeChromeStorageMock } from "./helpers/chrome-storage-mock";
import { handleHistoryCommand } from "../src/extension/background/history-command";
import { mergeRuns, HistoryRevisionError } from "../src/lib/agent/run-history";
import type { HistoryCommandMessage } from "../src/extension/background/message-types";
import type { RunRecord } from "../src/lib/agent/run-history-utils";

const OPTIONS_URL = "chrome-extension://test/options.html";
const SENDER = { id: "test", url: OPTIONS_URL } as chrome.runtime.MessageSender;
const ROGUE_SENDER = { id: "test", url: "chrome-extension://test/sidepanel.html" } as chrome.runtime.MessageSender;

let localStore: Map<string, unknown>;

function installChrome(local: Map<string, unknown> = new Map()): void {
  localStore = local;
  const mock = makeChromeStorageMock(local, new Map()) as unknown as Record<string, unknown>;
  (mock.runtime as Record<string, unknown>).getURL = (path: string) => `chrome-extension://test/${path}`;
  (mock.runtime as Record<string, unknown>).id = "test";
  (globalThis as Record<string, unknown>).chrome = mock as typeof chrome;
}

function makeRun(id: string, startedAt = Date.now()): RunRecord {
  return {
    id,
    task: `task-${id}`,
    startedAt,
    endedAt: startedAt + 1000,
    steps: [],
    logs: [],
    result: { success: true, text: "done" },
    totalTokensIn: 1,
    totalTokensOut: 1,
    totalCostUsd: 0.01,
    stepCount: 1,
    overflowCount: 0,
  };
}

function runCommand(msg: HistoryCommandMessage, sender = SENDER): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const keepOpen = handleHistoryCommand(msg, sender, (r) => resolve((r ?? {}) as Record<string, unknown>));
    expect(keepOpen).toBe(true);
  });
}

beforeEach(() => {
  installChrome();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).chrome;
});

describe("handleHistoryCommand — sender gating", () => {
  it("rejects senders outside the Options page", async () => {
    const res = await runCommand(
      { type: "HISTORY_COMMAND", version: 1, command: { kind: "list" } },
      ROGUE_SENDER,
    );
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("unauthorized");
  });
});

describe("handleHistoryCommand — list/clear/export/import", () => {
  it("lists stored runs with the current revision", async () => {
    localStore.set("open_cowork_run_history", [makeRun("r1")]);
    const res = await runCommand({ type: "HISTORY_COMMAND", version: 1, command: { kind: "list" } });
    expect(res.ok).toBe(true);
    expect((res.runs as unknown[]).length).toBe(1);
    expect(res.revision).toBe(0);
  });

  it("filters corrupted records out of the list (never emits garbage)", async () => {
    localStore.set("open_cowork_run_history", [
      makeRun("good"),
      { garbage: true },
      "string-entry",
      null,
      { id: "no-task" },
    ]);
    const res = await runCommand({ type: "HISTORY_COMMAND", version: 1, command: { kind: "list" } });
    expect(res.ok).toBe(true);
    const runs = res.runs as unknown[];
    expect(runs.length).toBe(1);
    expect((runs[0] as { id: string }).id).toBe("good");
  });

  it("clears history and bumps the revision in one atomic commit", async () => {
    localStore.set("open_cowork_run_history", [makeRun("r1")]);
    const res = await runCommand({ type: "HISTORY_COMMAND", version: 1, command: { kind: "clear" } });
    expect(res.ok).toBe(true);
    // The data (empty list) and the revision counter land in the SAME commit;
    // the key is stored as `[]` (readers treat it as an empty history) so the
    // atomic set can carry both values.
    expect(localStore.get("open_cowork_run_history")).toEqual([]);
    expect(localStore.get("open_cowork_run_history_revision")).toBe(1);
  });

  it("exports redacted runs (key-shaped tokens masked, never the raw value)", async () => {
    const run = makeRun("r1");
    const ghpToken = "ghp_" + "A".repeat(36);
    run.task = `exfil ${ghpToken}`;
    run.result = { success: true, text: "sk-ant-abcdefghijklmnopqrstuvwxyz" };
    localStore.set("open_cowork_run_history", [run]);
    const res = await runCommand({ type: "HISTORY_COMMAND", version: 1, command: { kind: "export" } });
    expect(res.ok).toBe(true);
    const json = JSON.stringify(res.runs);
    expect(json).not.toContain(ghpToken);
    expect(json).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz");
    expect(json).toContain("[redacted]");
  });

  it("imports valid entries, redacts them, and bumps the revision", async () => {
    const res = await runCommand({
      type: "HISTORY_COMMAND",
      version: 1,
      command: { kind: "import", entries: [makeRun("new-1"), { bogus: true }], expectedRevision: 0 },
    });
    expect(res.ok).toBe(true);
    expect(res.imported).toBe(1);
    expect(res.skippedInvalid).toBe(1);
    expect(res.revision).toBe(1);
    const stored = localStore.get("open_cowork_run_history") as RunRecord[];
    expect(stored.length).toBe(1);
    expect(stored[0].id).toBe("new-1");
    expect(localStore.get("open_cowork_run_history_revision")).toBe(1);
  });

  it("rejects a stale import with HISTORY_REVISION_CONFLICT and leaves data untouched", async () => {
    localStore.set("open_cowork_run_history", [makeRun("existing")]);
    localStore.set("open_cowork_run_history_revision", 3);
    const res = await runCommand({
      type: "HISTORY_COMMAND",
      version: 1,
      command: { kind: "import", entries: [makeRun("late")], expectedRevision: 2 },
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("HISTORY_REVISION_CONFLICT");
    expect((localStore.get("open_cowork_run_history") as RunRecord[]).map((r) => r.id)).toEqual(["existing"]);
    expect(localStore.get("open_cowork_run_history_revision")).toBe(3);
  });

  it("drops oversized entries before they reach storage (quota-safe import)", async () => {
    const huge = makeRun("huge");
    huge.logs = [{ ts: 1, level: "info", msg: "x".repeat(3_000_000) }] as unknown as RunRecord["logs"];
    const res = await runCommand({
      type: "HISTORY_COMMAND",
      version: 1,
      command: { kind: "import", entries: [huge, makeRun("ok")], expectedRevision: 0 },
    });
    expect(res.ok).toBe(true);
    expect(res.skippedInvalid).toBe(1);
    expect(res.imported).toBe(1);
    const stored = localStore.get("open_cowork_run_history") as RunRecord[];
    expect(stored.map((r) => r.id)).toEqual(["ok"]);
  });

  it("round-trips export → import → export without ever surfacing a credential", async () => {
    const ghpToken = "ghp_" + "B".repeat(36);
    const seeded = makeRun("seed");
    seeded.task = `round trip ${ghpToken}`;
    localStore.set("open_cowork_run_history", [seeded]);

    // Export: redacted.
    const exported = await runCommand({ type: "HISTORY_COMMAND", version: 1, command: { kind: "export" } });
    expect(JSON.stringify(exported.runs)).not.toContain(ghpToken);

    // Import the exported (already redacted) entries; re-export and confirm
    // the credential is still absent (redaction is idempotent across the loop).
    const imported = await runCommand({
      type: "HISTORY_COMMAND",
      version: 1,
      command: { kind: "import", entries: exported.runs as unknown[], expectedRevision: 0 },
    });
    expect(imported.ok).toBe(true);
    const reExported = await runCommand({ type: "HISTORY_COMMAND", version: 1, command: { kind: "export" } });
    const json = JSON.stringify(reExported.runs);
    expect(json).not.toContain(ghpToken);
    expect(json).toContain("[redacted]");
  });
});

describe("mergeRuns — multi-context concurrency", () => {
  it("serializes concurrent imports; exactly one wins, the other conflicts (no lost update)", async () => {
    const [first, second] = await Promise.allSettled([
      mergeRuns([makeRun("from-window-a", Date.now())], 0),
      mergeRuns([makeRun("from-window-b", Date.now())], 0),
    ]);
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    if (second.status === "rejected") {
      expect(second.reason).toBeInstanceOf(HistoryRevisionError);
    }
    const stored = localStore.get("open_cowork_run_history") as RunRecord[];
    // Exactly one window's entry persisted — the other was refused, not lost silently.
    expect(stored.length).toBe(1);
    expect(localStore.get("open_cowork_run_history_revision")).toBe(1);
  });

  it("a background save between an import's read and write makes the import conflict", async () => {
    const { saveRun } = await import("../src/lib/agent/run-history");
    // Simulate: window reads revision 0 (via list), then a run completes
    // (background save bumps to 1), then the window's import with 0 must fail.
    await saveRun(makeRun("completed-run", Date.now()));
    await expect(mergeRuns([makeRun("stale-window")], 0)).rejects.toBeInstanceOf(HistoryRevisionError);
  });
});

describe("mergeRuns — quota/corruption fail closed", () => {
  it("a storage write failure rejects the import and leaves the original data intact", async () => {
    localStore.set("open_cowork_run_history", [makeRun("original")]);
    localStore.set("open_cowork_run_history_revision", 0);
    const local = {
      get: async (key: string) => ({ [key]: localStore.get(key) }),
      set: async (items: Record<string, unknown>) => {
        if ("open_cowork_run_history" in items) {
          const err = new Error("QUOTA_BYTES exceeded") as Error & { name: string };
          err.name = "QuotaExceededError";
          throw err;
        }
        Object.entries(items).forEach(([k, v]) => localStore.set(k, v));
      },
      remove: async (key: string) => { localStore.delete(key); },
    } as unknown as chrome.storage.StorageArea;
    (globalThis as { chrome: { storage: { local: unknown } } }).chrome.storage.local = local;

    await expect(mergeRuns([makeRun("would-fail")], 0)).rejects.toThrow();
    // Nothing changed: original runs + revision intact, no partial write.
    expect((localStore.get("open_cowork_run_history") as RunRecord[]).map((r) => r.id)).toEqual(["original"]);
    expect(localStore.get("open_cowork_run_history_revision")).toBe(0);
  });

  it("a revision-counter write failure rolls back the data write", async () => {
    localStore.set("open_cowork_run_history", [makeRun("original")]);
    const local = {
      get: async (key: string) => ({ [key]: localStore.get(key) }),
      set: async (items: Record<string, unknown>) => {
        if ("open_cowork_run_history_revision" in items) {
          throw new Error("revision write failed");
        }
        Object.entries(items).forEach(([k, v]) => localStore.set(k, v));
      },
      remove: async (key: string) => { localStore.delete(key); },
    } as unknown as chrome.storage.StorageArea;
    (globalThis as { chrome: { storage: { local: unknown } } }).chrome.storage.local = local;

    await expect(mergeRuns([makeRun("new")], 0)).rejects.toThrow("revision write failed");
    // Data rolled back to the original list — revision and data never diverge.
    expect((localStore.get("open_cowork_run_history") as RunRecord[]).map((r) => r.id)).toEqual(["original"]);
  });
});
