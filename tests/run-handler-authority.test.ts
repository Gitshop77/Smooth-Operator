import { beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => {
  let resolveRecovery!: () => void;
  const makeRecovery = () => new Promise<void>((resolve) => { resolveRecovery = resolve; });
  return {
    makeRecovery,
    resolveRecovery: () => resolveRecovery(),
    waitForRunRecoveryAudit: vi.fn<() => Promise<void>>(),
    reserveManualRunAuthority: vi.fn(),
    discardReservedManualRun: vi.fn(async () => {}),
    startRun: vi.fn(async ({ onAdmitted }: { onAdmitted?: () => void } = {}) => {
      // Production startRun invokes onAdmitted once the run has passed every
      // admission gate — simulate that so the RUN ack path is exercised.
      onAdmitted?.();
    }),
    setRunStarting: vi.fn(),
    requestRunStartCancellation: vi.fn(),
    isRunStarting: vi.fn(() => false),
    getRunState: vi.fn(async () => null),
    saveRunState: vi.fn(async () => {}),
    requestCurrentRunCancellation: vi.fn(),
    getCurrentRunController: vi.fn(),
    persistRunSnapshot: vi.fn(async () => {}),
  };
});

vi.mock("../src/extension/background/agent-bridge", () => ({
  startRun: h.startRun,
  isRunStarting: h.isRunStarting,
  setRunStarting: h.setRunStarting,
  requestRunStartCancellation: h.requestRunStartCancellation,
  reserveManualRunAuthority: h.reserveManualRunAuthority,
  discardReservedManualRun: h.discardReservedManualRun,
  consumeDownloadConsentForMode: vi.fn(() => false),
  markDownloadConsentConsumed: vi.fn(),
  releaseDownloadConsentReservation: vi.fn(),
  DEFAULT_MAX_STEPS: 30,
  DEFAULT_MODE: "standard",
}));

vi.mock("../src/extension/background/state-store", () => ({
  getRunState: h.getRunState,
  saveRunState: h.saveRunState,
}));

vi.mock("../src/extension/background/run-recovery-gate", () => ({
  waitForRunRecoveryAudit: h.waitForRunRecoveryAudit,
}));

vi.mock("../src/extension/background/run-controller", () => ({
  canCurrentRunDispatch: vi.fn(() => false),
  getCurrentRunController: h.getCurrentRunController,
  requestCurrentRunCancellation: h.requestCurrentRunCancellation,
}));

vi.mock("../src/extension/background/run-snapshot-store", () => ({
  getPersistedRunSnapshot: vi.fn(async () => null),
  persistRunSnapshot: h.persistRunSnapshot,
}));

const { handleRun, handleStop } = await import("../src/extension/background/message-handlers");

describe("manual RUN admission authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.isRunStarting.mockReturnValue(false);
    h.waitForRunRecoveryAudit.mockResolvedValue(undefined);
    h.getRunState.mockResolvedValue(null);
    h.getCurrentRunController.mockReturnValue(null);
    h.requestCurrentRunCancellation.mockReturnValue(null);
  });

  test("reserves before the startup recovery await can yield to STOP", async () => {
    const recovery = h.makeRecovery();
    h.waitForRunRecoveryAudit.mockReturnValue(recovery);
    const runResponses: unknown[] = [];
    expect(handleRun(
      { task: "do not act after stop", maxSteps: 5, mode: "standard" },
      (response) => runResponses.push(response),
    )).toBe(true);

    // Recovery is deliberately unresolved. Authority must already exist at
    // this synchronous boundary so a STOP dispatched by Chrome cannot miss it.
    expect(h.setRunStarting).toHaveBeenCalledWith(true);
    expect(h.reserveManualRunAuthority).toHaveBeenCalledWith({
      task: "do not act after stop",
      maxSteps: 5,
      mode: "standard",
    });
    expect(h.getRunState).not.toHaveBeenCalled();

    const cancelling = {
      version: 1,
      runId: "pending-run",
      revision: 2,
      dispatchRevision: 2,
      task: "do not act after stop",
      maxSteps: 5,
      mode: "standard",
      status: "cancelling",
      phase: "cancelling",
      step: 0,
      startedAt: 1,
      updatedAt: 2,
    } as const;
    h.requestCurrentRunCancellation.mockReturnValue(cancelling);
    h.getCurrentRunController.mockReturnValue({ snapshot: cancelling });
    h.isRunStarting.mockReturnValue(true);
    const stopResponse = new Promise<unknown>((resolve) => {
      expect(handleStop(resolve)).toBe(true);
    });
    expect(h.requestCurrentRunCancellation).toHaveBeenCalledTimes(1);
    expect(h.getRunState).not.toHaveBeenCalled();
    expect(h.persistRunSnapshot).not.toHaveBeenCalled();

    h.resolveRecovery();
    await expect(stopResponse).resolves.toMatchObject({
      ok: true,
      status: "cancelling",
      snapshot: {
        ...cancelling,
        task: "[REDACTED: live secret redaction unavailable]",
      },
    });
    expect(h.requestRunStartCancellation).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(h.startRun).toHaveBeenCalledTimes(1));
    expect(runResponses).toContainEqual({ ok: true });
  });

  test("rejects and discards a reserved run when startup recovery cannot prove safety", async () => {
    const recoveryError = new Error("session storage unavailable");
    h.waitForRunRecoveryAudit.mockRejectedValueOnce(recoveryError);
    const response = new Promise<unknown>((resolve) => {
      expect(handleRun({ task: "must fail closed", maxSteps: 5, mode: "standard" }, resolve)).toBe(true);
    });

    await expect(response).resolves.toEqual({ ok: false, error: recoveryError.message });
    expect(h.reserveManualRunAuthority).toHaveBeenCalledTimes(1);
    expect(h.discardReservedManualRun).toHaveBeenCalledWith(recoveryError.message);
    expect(h.getRunState).not.toHaveBeenCalled();
    expect(h.startRun).not.toHaveBeenCalled();
  });

  test("STOP waits for startup admission before reading or mutating session authority", async () => {
    const recovery = h.makeRecovery();
    h.waitForRunRecoveryAudit.mockReturnValue(recovery);
    h.isRunStarting.mockReturnValue(true);

    const response = new Promise<unknown>((resolve) => {
      expect(handleStop(resolve)).toBe(true);
    });

    // Emergency in-memory cancellation is attempted synchronously, but no
    // session authority boundary is crossed before trusted startup succeeds.
    expect(h.requestCurrentRunCancellation).toHaveBeenCalledTimes(1);
    expect(h.getRunState).not.toHaveBeenCalled();
    expect(h.saveRunState).not.toHaveBeenCalled();
    expect(h.persistRunSnapshot).not.toHaveBeenCalled();

    h.resolveRecovery();
    await expect(response).resolves.toEqual({ ok: true, status: "idle" });
    expect(h.getRunState).toHaveBeenCalledTimes(1);
    expect(h.requestRunStartCancellation).toHaveBeenCalledTimes(1);
    expect(h.saveRunState).toHaveBeenCalledWith({ abortRequested: true });
  });

  test("STOP fails closed without session authority access when startup admission rejects", async () => {
    const recoveryError = new Error("trusted session storage unavailable");
    h.waitForRunRecoveryAudit.mockRejectedValueOnce(recoveryError);

    const response = new Promise<unknown>((resolve) => {
      expect(handleStop(resolve)).toBe(true);
    });

    await expect(response).resolves.toEqual({
      ok: false,
      error: recoveryError.message,
    });
    expect(h.requestCurrentRunCancellation).toHaveBeenCalledTimes(1);
    expect(h.getRunState).not.toHaveBeenCalled();
    expect(h.saveRunState).not.toHaveBeenCalled();
    expect(h.persistRunSnapshot).not.toHaveBeenCalled();
    expect(h.requestRunStartCancellation).not.toHaveBeenCalled();
  });
});
