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
  DEFAULT_MODE: "standard",
  isRunStarting: vi.fn(() => false),
  setRunStarting: vi.fn(),
  isRunStartCancellationRequested: vi.fn(() => false),
  reserveScheduledRunAuthority: vi.fn(() => ({ controller: { signal: { aborted: false } } })),
  discardReservedRunAuthority: vi.fn(async () => {}),
  startRun: vi.fn(async () => {}),
}));

vi.mock("../src/extension/background/run-recovery-gate", () => ({
  waitForRunRecoveryAudit: vi.fn(async () => {}),
}));

vi.mock("@/lib/agent/scheduled-tasks", () => ({
  getScheduledTask: vi.fn(),
  recordScheduledTaskRun: vi.fn(async () => {}),
}));

vi.mock("../src/extension/background/state-store", () => ({
  clearRunState: vi.fn(async () => {}),
  getRunState: vi.fn(async () => undefined),
  requestKeepAwake: vi.fn(async () => {}),
  safeLog: vi.fn(),
}));

import { handleScheduledTaskFire } from "../src/extension/background/task-queue";
import { getScheduledTask, recordScheduledTaskRun } from "@/lib/agent/scheduled-tasks";
import { clearRunState, getRunState, requestKeepAwake, safeLog } from "../src/extension/background/state-store";
import { waitForRunRecoveryAudit } from "../src/extension/background/run-recovery-gate";
import {
  isRunStarting,
  isRunStartCancellationRequested,
  reserveScheduledRunAuthority,
  startRun,
  setRunStarting,
} from "../src/extension/background/agent-bridge";
import { setSecret, deleteSecret } from "../src/lib/agent/secrets";
import { installLocalStorageStub, restoreLocalStorageStub } from "./helpers";

const getScheduledTaskMock = getScheduledTask as ReturnType<typeof vi.fn>;
const recordScheduledTaskRunMock = recordScheduledTaskRun as ReturnType<typeof vi.fn>;
const getRunStateMock = getRunState as ReturnType<typeof vi.fn>;
const requestKeepAwakeMock = requestKeepAwake as ReturnType<typeof vi.fn>;
const clearRunStateMock = clearRunState as ReturnType<typeof vi.fn>;
const safeLogMock = safeLog as ReturnType<typeof vi.fn>;
const waitForRunRecoveryAuditMock = waitForRunRecoveryAudit as ReturnType<typeof vi.fn>;
const isRunStartingMock = isRunStarting as ReturnType<typeof vi.fn>;
const startRunMock = startRun as ReturnType<typeof vi.fn>;
const setRunStartingMock = setRunStarting as ReturnType<typeof vi.fn>;
const reserveScheduledRunAuthorityMock = reserveScheduledRunAuthority as ReturnType<typeof vi.fn>;
const isRunStartCancellationRequestedMock = isRunStartCancellationRequested as ReturnType<typeof vi.fn>;

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
  clearRunStateMock.mockResolvedValue(undefined);
  waitForRunRecoveryAuditMock.mockResolvedValue(undefined);
  isRunStartCancellationRequestedMock.mockReturnValue(false);
  stubChrome();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).chrome;
});

describe("handleScheduledTaskFire re-entry guards", () => {
  test("awaits recovery before task lookup or scheduled ownership reservation", async () => {
    let releaseRecovery!: () => void;
    waitForRunRecoveryAuditMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseRecovery = resolve; }),
    );
    const fire = handleScheduledTaskFire("task-1");

    expect(getScheduledTaskMock).not.toHaveBeenCalled();
    expect(reserveScheduledRunAuthorityMock).not.toHaveBeenCalled();

    releaseRecovery();
    await fire;

    expect(getScheduledTaskMock).toHaveBeenCalledWith("task-1");
    expect(reserveScheduledRunAuthorityMock).toHaveBeenCalledTimes(1);
    expect(startRunMock).toHaveBeenCalledTimes(1);
  });

  test("fails closed when recovery cannot prove the prior worker safe", async () => {
    const failure = new Error("orphan cleanup failed");
    waitForRunRecoveryAuditMock.mockRejectedValueOnce(failure);

    await handleScheduledTaskFire("task-1");

    expect(getScheduledTaskMock).not.toHaveBeenCalled();
    expect(reserveScheduledRunAuthorityMock).not.toHaveBeenCalled();
    expect(startRunMock).not.toHaveBeenCalled();
    expect(safeLogMock).toHaveBeenCalledWith(
      "error",
      "[scheduled-tasks] recovery audit failed; refusing alarm run:",
      failure,
    );
    expect(setRunStartingMock).toHaveBeenLastCalledWith(false);
  });

  test("a STOP latched during the pre-reservation task lookup prevents all later side effects", async () => {
    let releaseTask!: (task: unknown) => void;
    getScheduledTaskMock.mockImplementationOnce(
      () => new Promise((resolve) => { releaseTask = resolve; }),
    );
    const fire = handleScheduledTaskFire("task-1");
    await vi.waitFor(() => expect(getScheduledTaskMock).toHaveBeenCalledTimes(1));

    // handleStop records this latch while runStarting is true. The task queue
    // must observe it before a controller, keep-awake request, task write,
    // notification, side-panel open, or startRun can happen.
    isRunStartCancellationRequestedMock.mockReturnValue(true);
    releaseTask({ id: "task-1", task: "do the thing", enabled: true, mode: "standard", lastRunAt: 0 });
    await fire;

    expect(reserveScheduledRunAuthorityMock).not.toHaveBeenCalled();
    expect(requestKeepAwakeMock).not.toHaveBeenCalled();
    expect(recordScheduledTaskRunMock).not.toHaveBeenCalled();
    expect(startRunMock).not.toHaveBeenCalled();
    expect(clearRunStateMock).toHaveBeenCalledTimes(1);
  });

  test("skips when a manual run is already starting (runStarting guard)", async () => {
    isRunStartingMock.mockReturnValue(true);
    await handleScheduledTaskFire("task-1");
    expect(recordScheduledTaskRunMock).not.toHaveBeenCalled();
    expect(requestKeepAwakeMock).not.toHaveBeenCalled();
    expect(startRunMock).not.toHaveBeenCalled();
  });

  test("skips when a run is already active", async () => {
    getRunStateMock.mockResolvedValue({ active: true });
    await handleScheduledTaskFire("task-1");
    expect(recordScheduledTaskRunMock).not.toHaveBeenCalled();
    expect(startRunMock).not.toHaveBeenCalled();
  });

  test("skips when the task was deleted or disabled", async () => {
    getScheduledTaskMock.mockResolvedValue(null);
    await handleScheduledTaskFire("task-1");
    expect(recordScheduledTaskRunMock).not.toHaveBeenCalled();
    expect(startRunMock).not.toHaveBeenCalled();
  });

  test("acquires the guard BEFORE any side effects, then starts the run", async () => {
    await handleScheduledTaskFire("task-1");
    expect(setRunStartingMock).toHaveBeenCalledWith(true);
    expect(recordScheduledTaskRunMock).toHaveBeenCalledWith("task-1", expect.any(Number));
    expect(startRunMock).toHaveBeenCalledTimes(1);
    expect(reserveScheduledRunAuthorityMock).toHaveBeenCalledWith({
      task: "do the thing",
      maxSteps: 100,
      mode: "standard",
    });
    expect(startRunMock).toHaveBeenCalledWith(expect.objectContaining({
      task: "do the thing",
      maxSteps: 100,
      mode: "standard",
      isScheduledTaskRun: true,
    }));
  });

  test("a corrupted stored mode falls back to DEFAULT_MODE (never fed raw to startRun)", async () => {
    getScheduledTaskMock.mockResolvedValue({
      id: "task-1",
      task: "do the thing",
      enabled: true,
      mode: "not-a-real-mode",
      lastRunAt: 0,
    });
    await handleScheduledTaskFire("task-1");
    expect(startRunMock).toHaveBeenCalledTimes(1);
    expect(startRunMock).toHaveBeenCalledWith(expect.objectContaining({
      task: "do the thing",
      maxSteps: 100,
      mode: "standard",
      isScheduledTaskRun: true,
    }));
  });
});

describe("handleScheduledTaskFire notification redaction", () => {
  let notificationsMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    installLocalStorageStub();
    notificationsMock = (globalThis as unknown as { chrome: { notifications: { create: ReturnType<typeof vi.fn> } } }).chrome.notifications.create;
  });

  afterEach(async () => {
    await deleteSecret("api_key").catch(() => {});
    localStorage.removeItem("open_cowork_secrets");
    restoreLocalStorageStub();
  });

  test("the 'Starting' notification redacts secrets embedded in the task prompt", async () => {
    const SECRET = "sk-scheduled-notif-999";
    await setSecret("api_key", SECRET);

    getScheduledTaskMock.mockResolvedValue({
      id: "task-1",
      task: `fill the form with ${SECRET}`,
      enabled: true,
      mode: "standard",
      lastRunAt: 0,
    });

    await handleScheduledTaskFire("task-1");

    expect(notificationsMock).toHaveBeenCalledTimes(1);
    const opts = (notificationsMock.mock.calls[0] as unknown[])[0] as { message?: string };
    expect(opts.message).toBeDefined();
    expect(opts.message).toContain("[REDACTED:api_key]");
    expect(opts.message).not.toContain(SECRET);
  });
});
