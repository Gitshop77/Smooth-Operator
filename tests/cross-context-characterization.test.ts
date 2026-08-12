/**
 * Cross-context scheduled-task characterization.
 *
 * These cases intentionally drive the Options-page event handlers and the
 * background/library writer through separate module-local locks. They are not
 * unit tests for either mutex: Chrome storage and alarms are shared between
 * independent extension contexts, so a page-local lock cannot serialize the
 * service worker's result persistence.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ScheduledTask } from "../src/lib/agent/scheduled-tasks";

const STORAGE_KEY = "open_cowork_scheduled_tasks";
const ALARM_PREFIX = "open_cowork_scheduled_";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function fixtureTask(id: string, enabled = true, lastRunAt?: number): ScheduledTask {
  return {
    id,
    task: `fake fixture task ${id}`,
    schedule: { type: "interval", intervalMinutes: 30 },
    enabled,
    createdAt: 1_700_000_000_000,
    ...(lastRunAt === undefined ? {} : { lastRunAt }),
  };
}

function installScheduleDom(): void {
  document.body.innerHTML = `
    <select id="scheduleType"><option value="interval" selected>Interval</option></select>
    <input id="scheduleInterval">
    <input id="scheduleTime">
    <select id="scheduleDay"><option value="1" selected>Monday</option></select>
    <select id="scheduleMode"><option value="standard" selected>Standard</option></select>
    <input id="scheduleTask">
    <button id="addSchedule" type="button">Add</button>
    <div id="scheduleList"></div>
  `;
}

type StorageHooks = {
  onGet?: (call: number) => Promise<void> | void;
  onSet?: (value: Record<string, unknown>) => Promise<void> | void;
};

function installCrossContextChrome(storage: Record<string, unknown>, hooks: StorageHooks = {}) {
  const activeAlarms = new Set<string>();
  let getCalls = 0;
  const local = {
    get: vi.fn(async (key: string) => {
      getCalls += 1;
      // A storage read has already captured its value before the caller can be
      // descheduled. Holding *after* this clone is what makes the interleaving
      // a real stale-read race rather than merely delaying a fresh read.
      const result = key in storage ? { [key]: clone(storage[key]) } : {};
      await hooks.onGet?.(getCalls);
      return result;
    }),
    set: vi.fn(async (value: Record<string, unknown>) => {
      await hooks.onSet?.(value);
      for (const [key, item] of Object.entries(value)) storage[key] = clone(item);
    }),
    remove: vi.fn(async (key: string) => { delete storage[key]; }),
  };
  const alarms = {
    create: vi.fn(async (name: string) => { activeAlarms.add(name); }),
    clear: vi.fn(async (name: string) => {
      activeAlarms.delete(name);
      return true;
    }),
    get: vi.fn(async () => undefined),
    getAll: vi.fn(async () => []),
    onAlarm: { addListener: vi.fn() },
  };
  const runtime = {
    id: "scheduler-extension-fixture",
    getURL: (path: string) => `chrome-extension://scheduler-extension-fixture/${path}`,
    sendMessage: vi.fn(async (message: unknown) => {
      const { handleScheduledTaskCommand } = await import("../src/extension/background/scheduled-task-command");
      return new Promise<unknown>((resolve) => {
        handleScheduledTaskCommand(
          message as never,
          {
            id: "scheduler-extension-fixture",
            url: "chrome-extension://scheduler-extension-fixture/options.html",
          },
          resolve,
        );
      });
    }),
  };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local },
    alarms,
    runtime,
    power: { requestKeepAwake: vi.fn(), releaseKeepAwake: vi.fn() },
  };
  return { local, alarms, activeAlarms, runtime };
}

async function loadOptionsSchedule(): Promise<typeof import("../src/extension/options/scheduled-tasks")> {
  installScheduleDom();
  const options = await import("../src/extension/options/scheduled-tasks");
  await options.renderSchedule();
  return options;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome;
  document.body.innerHTML = "";
});

describe("Cross-context harness credibility controls", () => {
  test("the real Options delete handler removes one isolated task and clears its alarm", async () => {
    const task = fixtureTask("delete-smoke");
    const storage: Record<string, unknown> = { [STORAGE_KEY]: [task] };
    const { alarms, activeAlarms } = installCrossContextChrome(storage);
    const alarmName = `${ALARM_PREFIX}${task.id}`;
    activeAlarms.add(alarmName);

    await loadOptionsSchedule();
    const deleteButton = document.querySelector(".schedule-delete") as HTMLButtonElement | null;
    expect(deleteButton).toBeInstanceOf(HTMLButtonElement);
    expect(deleteButton?.textContent).toBe("Delete");
    deleteButton!.click();

    // Destructive-action gate: confirm the danger modal explicitly.
    await new Promise((r) => setTimeout(r, 250));
    const overlay = document.querySelector(".modal-overlay");
    const footer = overlay?.querySelectorAll<HTMLButtonElement>(".modal-footer button");
    footer?.[footer.length - 1]?.click();

    await vi.waitFor(() => expect(storage[STORAGE_KEY]).toEqual([]));
    expect(alarms.clear).toHaveBeenCalledWith(alarmName);
    expect(activeAlarms.has(alarmName)).toBe(false);
  });

  test("the real Options toggle handler enables one isolated task through alarm clear/create", async () => {
    const task = fixtureTask("toggle-smoke", false);
    const storage: Record<string, unknown> = { [STORAGE_KEY]: [task] };
    const { alarms, activeAlarms } = installCrossContextChrome(storage);
    const alarmName = `${ALARM_PREFIX}${task.id}`;

    await loadOptionsSchedule();
    const toggleButton = document.querySelector(".toggle-enable") as HTMLButtonElement | null;
    expect(toggleButton).toBeInstanceOf(HTMLButtonElement);
    expect(toggleButton?.textContent).toBe("Enable");
    toggleButton!.click();

    await vi.waitFor(() => {
      const persisted = (storage[STORAGE_KEY] as ScheduledTask[])[0];
      expect(persisted).toMatchObject({ id: task.id, enabled: true });
      expect(persisted.nextRunAt).toBeTypeOf("number");
      expect(alarms.create).toHaveBeenCalled();
    });
    expect(alarms.clear).toHaveBeenCalledWith(alarmName);
    expect(alarms.create).toHaveBeenCalledWith(
      alarmName,
      expect.objectContaining({ periodInMinutes: 30 }),
    );
    expect(activeAlarms.has(alarmName)).toBe(true);
  });

  test("the background/library result writer persists an isolated lastRunAt update and re-arms", async () => {
    const task = fixtureTask("result-writer-smoke", true, 111);
    const storage: Record<string, unknown> = { [STORAGE_KEY]: [task] };
    const { alarms, activeAlarms } = installCrossContextChrome(storage);
    const alarmName = `${ALARM_PREFIX}${task.id}`;
    const { saveScheduledTask } = await import("../src/lib/agent/scheduled-tasks");

    await saveScheduledTask({ ...task, lastRunAt: 222 });

    const persisted = (storage[STORAGE_KEY] as ScheduledTask[])[0];
    expect(persisted).toMatchObject({ id: task.id, enabled: true, lastRunAt: 222 });
    expect(persisted.nextRunAt).toBeTypeOf("number");
    expect(alarms.clear).toHaveBeenCalledWith(alarmName);
    expect(alarms.create).toHaveBeenCalledWith(
      alarmName,
      expect.objectContaining({ periodInMinutes: 30 }),
    );
    expect(activeAlarms.has(alarmName)).toBe(true);
  });
});

describe("Background scheduled-task command authority", () => {
  test("accepts the absent-version legacy adapter and rejects unknown command versions", async () => {
    const task = fixtureTask("command-version");
    const storage: Record<string, unknown> = { [STORAGE_KEY]: [task] };
    const { runtime } = installCrossContextChrome(storage);

    await expect(runtime.sendMessage({
      type: "SCHEDULED_TASK_COMMAND",
      command: { kind: "list" },
    })).resolves.toMatchObject({ ok: true, tasks: [task] });
    await expect(runtime.sendMessage({
      type: "SCHEDULED_TASK_COMMAND",
      version: 2,
      command: { kind: "list" },
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/unsupported.*version/i),
    });
  });

  test("rejects scheduled-task commands from non-Options extension contexts", async () => {
    const task = fixtureTask("sender-gate");
    const storage: Record<string, unknown> = { [STORAGE_KEY]: [task] };
    installCrossContextChrome(storage);
    const { handleScheduledTaskCommand } = await import("../src/extension/background/scheduled-task-command");
    let response: unknown;

    expect(handleScheduledTaskCommand(
      { type: "SCHEDULED_TASK_COMMAND", command: { kind: "list" } },
      {
        id: "scheduler-extension-fixture",
        url: "https://example.test/content-script",
      },
      (value) => { response = value; },
    )).toBe(false);
    expect(response).toEqual({ ok: false, error: "unauthorized scheduled-task sender" });
    expect(storage[STORAGE_KEY]).toEqual([task]);
  });

  test("fails closed when a stale toggle revision also has a changed enabled field", async () => {
    const task = { ...fixtureTask("revision-conflict", false), revision: 2 };
    const storage: Record<string, unknown> = { [STORAGE_KEY]: [task] };
    const { runtime } = installCrossContextChrome(storage);

    const response = await runtime.sendMessage({
      type: "SCHEDULED_TASK_COMMAND",
      command: {
        kind: "set_enabled",
        taskId: task.id,
        enabled: false,
        expectedRevision: 1,
        expectedEnabled: true,
      },
    }) as { ok?: boolean; code?: string };

    expect(response).toMatchObject({ ok: false, code: "SCHEDULED_TASK_REVISION_CONFLICT" });
    expect(storage[STORAGE_KEY]).toEqual([task]);
  });

  test("rolls storage back when creating the alarm for a new task fails", async () => {
    const task = fixtureTask("create-failure");
    const storage: Record<string, unknown> = { [STORAGE_KEY]: [] };
    const { alarms, activeAlarms, runtime } = installCrossContextChrome(storage);
    alarms.create.mockRejectedValueOnce(new Error("fake alarm create failure"));

    const response = await runtime.sendMessage({
      type: "SCHEDULED_TASK_COMMAND",
      command: { kind: "save", task, expectedRevision: null },
    }) as { ok?: boolean; error?: string };

    expect(response.ok).toBe(false);
    expect(response.error).toContain("fake alarm create failure");
    expect(storage[STORAGE_KEY]).toEqual([]);
    expect(activeAlarms.has(`${ALARM_PREFIX}${task.id}`)).toBe(false);
  });

  test("keeps a task durable when its alarm cannot be cleared for deletion", async () => {
    const task = fixtureTask("delete-clear-failure");
    const storage: Record<string, unknown> = { [STORAGE_KEY]: [task] };
    const { alarms, activeAlarms, runtime } = installCrossContextChrome(storage);
    activeAlarms.add(`${ALARM_PREFIX}${task.id}`);
    alarms.clear.mockRejectedValueOnce(new Error("fake alarm clear failure"));

    const response = await runtime.sendMessage({
      type: "SCHEDULED_TASK_COMMAND",
      command: {
        kind: "delete",
        taskId: task.id,
        expectedRevision: 0,
        expectedCreatedAt: task.createdAt,
      },
    }) as { ok?: boolean; error?: string };

    expect(response.ok).toBe(false);
    expect(response.error).toContain("fake alarm clear failure");
    expect(storage[STORAGE_KEY]).toEqual([task]);
    expect(activeAlarms.has(`${ALARM_PREFIX}${task.id}`)).toBe(true);
  });
});

describe("True Options/background scheduled-task races", () => {
  test("an Options delete cannot overwrite a concurrent background save with its stale full list", async () => {
    const first = fixtureTask("delete-target");
    const second = fixtureTask("background-result");
    const storage: Record<string, unknown> = { [STORAGE_KEY]: [first, second] };
    const backgroundClearStarted = deferred();
    const releaseBackgroundClear = deferred();
    const { alarms, runtime } = installCrossContextChrome(storage);
    alarms.clear.mockImplementationOnce(async (name: string) => {
      backgroundClearStarted.resolve();
      await releaseBackgroundClear.promise;
      return name.length > 0;
    });
    const options = await loadOptionsSchedule();

    const { saveScheduledTask } = await import("../src/lib/agent/scheduled-tasks");
    const workerSave = saveScheduledTask({ ...second, task: "fake background result update" });
    await backgroundClearStarted.promise;
    (document.querySelector(".schedule-delete") as HTMLButtonElement).click();
    // Destructive-action gate: confirm the danger modal explicitly.
    await new Promise((r) => setTimeout(r, 250));
    const overlay = document.querySelector(".modal-overlay");
    const footer = overlay?.querySelectorAll<HTMLButtonElement>(".modal-footer button");
    footer?.[footer.length - 1]?.click();
    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "SCHEDULED_TASK_COMMAND",
      version: 1,
      command: expect.objectContaining({ kind: "delete", taskId: first.id }),
    })));
    releaseBackgroundClear.resolve();
    await workerSave;
    await vi.waitFor(() => expect(storage[STORAGE_KEY]).toHaveLength(1));

    const persisted = storage[STORAGE_KEY] as ScheduledTask[];
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      id: second.id,
      task: "fake background result update",
    });
    // Keep a real Options render in the trace; this must not devolve into a
    // direct storage mock test that happens to fail for an unrelated reason.
    await options.renderSchedule();
  });

  test("an Options toggle preserves a concurrently persisted scheduled-run result", async () => {
    const task = fixtureTask("toggle-target", true, 111);
    const storage: Record<string, unknown> = { [STORAGE_KEY]: [task] };
    const backgroundClearStarted = deferred();
    const releaseBackgroundClear = deferred();
    const { alarms, runtime } = installCrossContextChrome(storage);
    alarms.clear.mockImplementationOnce(async (name: string) => {
      backgroundClearStarted.resolve();
      await releaseBackgroundClear.promise;
      return name.length > 0;
    });
    await loadOptionsSchedule();
    const { saveScheduledTask } = await import("../src/lib/agent/scheduled-tasks");

    const workerResult = saveScheduledTask({ ...task, lastRunAt: 222 });
    await backgroundClearStarted.promise;
    (document.querySelector(".toggle-enable") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "SCHEDULED_TASK_COMMAND",
      command: expect.objectContaining({ kind: "set_enabled", taskId: task.id, enabled: false }),
    })));
    releaseBackgroundClear.resolve();
    await workerResult;
    await vi.waitFor(() => {
      expect((storage[STORAGE_KEY] as ScheduledTask[])[0]).toMatchObject({ enabled: false });
    });

    const persisted = (storage[STORAGE_KEY] as ScheduledTask[])[0];
    expect(persisted).toMatchObject({ id: task.id, enabled: false, lastRunAt: 222 });
  });

  test("a background re-arm cannot leave a deleted Options task with a live alarm", async () => {
    const task = fixtureTask("alarm-storage-target", true, 111);
    const storage: Record<string, unknown> = { [STORAGE_KEY]: [task] };
    const backgroundClearStarted = deferred();
    const releaseBackgroundClear = deferred();
    let clearCalls = 0;
    const { alarms, activeAlarms, runtime } = installCrossContextChrome(storage);
    alarms.clear.mockImplementation(async (name: string) => {
      clearCalls += 1;
      if (clearCalls === 1) {
        backgroundClearStarted.resolve();
        await releaseBackgroundClear.promise;
      }
      activeAlarms.delete(name);
      return true;
    });
    await loadOptionsSchedule();
    const { saveScheduledTask } = await import("../src/lib/agent/scheduled-tasks");

    const backgroundResult = saveScheduledTask({ ...task, lastRunAt: 222 });
    await backgroundClearStarted.promise;
    (document.querySelector(".schedule-delete") as HTMLButtonElement).click();
    // Destructive-action gate: confirm the danger modal explicitly.
    await new Promise((r) => setTimeout(r, 250));
    const overlay = document.querySelector(".modal-overlay");
    const footer = overlay?.querySelectorAll<HTMLButtonElement>(".modal-footer button");
    footer?.[footer.length - 1]?.click();
    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "SCHEDULED_TASK_COMMAND",
      command: expect.objectContaining({ kind: "delete", taskId: task.id }),
    })));
    releaseBackgroundClear.resolve();
    await backgroundResult;
    await vi.waitFor(() => expect(storage[STORAGE_KEY]).toEqual([]));

    expect(storage[STORAGE_KEY]).toEqual([]);
    expect(activeAlarms.has(`${ALARM_PREFIX}${task.id}`)).toBe(false);
  });
});
