/**
 * task-queue.ts — handleScheduledTaskFire mutual exclusion.
 *
 * A scheduled-task alarm fire must never start a second run while a manual
 * run is starting (or mid-run): the runStarting guard + active-run-state
 * check are the two re-entry barriers, and both must be consulted BEFORE any
 * side effects (keep-awake lock, lastRunAt persist, sidePanel.open,
 * startRun).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/extension/background/agent-bridge", () => ({
  DEFAULT_MAX_STEPS: 100,
  isRunStarting: vi.fn(() => false),
  setRunStarting: vi.fn(),
  startRun: vi.fn(async () => {}),
}));

vi.mock("@/lib/agent/scheduled-tasks", () => ({
  getScheduledTask: vi.fn(),
  saveScheduledTask: vi.fn(async () => {}),
}));

vi.mock("../src/extension/background/state-store", () => ({
  getRunState: vi.fn(async () => undefined),
  requestKeepAwake: vi.fn(async () => {}),
  safeLog: vi.fn(),
}));

import { handleScheduledTaskFire } from "../src/extension/background/task-queue";
import { getScheduledTask, saveScheduledTask } from "@/lib/agent/scheduled-tasks";
import { getRunState, requestKeepAwake } from "../src/extension/background/state-store";
import { isRunStarting, startRun, setRunStarting } from "../src/extension/background/agent-bridge";

const getScheduledTaskMock = getScheduledTask as ReturnType<typeof vi.fn>;
const saveScheduledTaskMock = saveScheduledTask as ReturnType<typeof vi.fn>;
const getRunStateMock = getRunState as ReturnType<typeof vi.fn>;
const requestKeepAwakeMock = requestKeepAwake as ReturnType<typeof vi.fn>;
const isRunStartingMock = isRunStarting as ReturnType<typeof vi.fn>;
const startRunMock = startRun as ReturnType<typeof vi.fn>;
const setRunStartingMock = setRunStarting as ReturnType<typeof vi.fn>;

function stubChrome(): void {
  (globalThis as Record<string, unknown>).chrome = {
    sidePanel: {
      open: vi.fn(async () => {
        throw new Error("no user gesture");
      }),
    },
    action: {
      setBadgeText: vi.fn(),
      setBadgeBackgroundColor: vi.fn(),
    },
    notifications: {
      create: vi.fn(),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getScheduledTaskMock.mockResolvedValue({
    id: "task-1",
    task: "do the thing",
    enabled: true,
    mode: "standard",
    lastRunAt: 0,
  });
  isRunStartingMock.mockReturnValue(false);
  getRunStateMock.mockResolvedValue(undefined);
  requestKeepAwakeMock.mockResolvedValue(undefined);
  stubChrome();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).chrome;
});

describe("handleScheduledTaskFire re-entry guards", () => {
  test("skips when a manual run is already starting (runStarting guard)", async () => {
    isRunStartingMock.mockReturnValue(true);
    await handleScheduledTaskFire("task-1");
    expect(saveScheduledTaskMock).not.toHaveBeenCalled();
    expect(requestKeepAwakeMock).not.toHaveBeenCalled();
    expect(startRunMock).not.toHaveBeenCalled();
  });

  test("skips when a run is already active", async () => {
    getRunStateMock.mockResolvedValue({ active: true });
    await handleScheduledTaskFire("task-1");
    expect(saveScheduledTaskMock).not.toHaveBeenCalled();
    expect(startRunMock).not.toHaveBeenCalled();
  });

  test("skips when the task was deleted or disabled", async () => {
    getScheduledTaskMock.mockResolvedValue(null);
    await handleScheduledTaskFire("task-1");
    expect(saveScheduledTaskMock).not.toHaveBeenCalled();
    expect(startRunMock).not.toHaveBeenCalled();
  });

  test("acquires the guard BEFORE any side effects, then starts the run", async () => {
    await handleScheduledTaskFire("task-1");
    expect(setRunStartingMock).toHaveBeenCalledWith(true);
    expect(saveScheduledTaskMock).toHaveBeenCalled();
    expect(startRunMock).toHaveBeenCalledTimes(1);
    expect(startRunMock).toHaveBeenCalledWith({
      task: "do the thing",
      maxSteps: 100,
      mode: "standard",
      isScheduledTaskRun: true,
    });
  });
});
