import type { AgentMode } from "@/lib/agent/modes";
import type {
  RunLifecycleStatus,
  RunPhase,
  RunSnapshotUsage,
  RunSnapshotV1,
  RunTerminalReason,
} from "@/lib/agent/run-lifecycle-contract";

export type {
  RunLifecycleStatus,
  RunPhase,
  RunSnapshotV1,
  RunTerminalReason,
} from "@/lib/agent/run-lifecycle-contract";

export interface RunDispatchToken {
  runId: string;
  dispatchRevision: number;
}

interface BeginRunOptions {
  runId: string;
  task: string;
  maxSteps: number;
  mode: AgentMode;
  now?: number;
}

interface RunProgressPatch {
  phase?: Exclude<RunPhase, "terminal">;
  step?: number;
  activeOperation?: string;
  usage?: RunSnapshotUsage;
}

interface RunConfigurationPatch {
  maxSteps: number;
  mode: AgentMode;
}

const TERMINAL_STATUSES: ReadonlySet<RunLifecycleStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

function statusForTerminalReason(reason: RunTerminalReason): RunLifecycleStatus {
  if (reason === "succeeded") return "succeeded";
  if (reason === "cancelled") return "cancelled";
  if (reason === "interrupted") return "interrupted";
  return "failed";
}

/**
 * Background-owned, in-memory authority for one run revision.
 *
 * Persisted snapshots are projections for recovery/UI hydration; they never
 * authorize dispatch. Only this controller and a matching dispatch token can.
 */
export class RunController {
  readonly rootAbortController = new AbortController();
  private snapshotValue: RunSnapshotV1;

  constructor(options: BeginRunOptions) {
    const now = options.now ?? Date.now();
    this.snapshotValue = {
      version: 1,
      runId: options.runId,
      revision: 1,
      dispatchRevision: 1,
      task: options.task,
      maxSteps: options.maxSteps,
      mode: options.mode,
      status: "starting",
      phase: "starting",
      step: 0,
      startedAt: now,
      updatedAt: now,
    };
  }

  get signal(): AbortSignal {
    return this.rootAbortController.signal;
  }

  get snapshot(): RunSnapshotV1 {
    return {
      ...this.snapshotValue,
      ...(this.snapshotValue.usage ? { usage: { ...this.snapshotValue.usage } } : {}),
    };
  }

  get dispatchToken(): RunDispatchToken {
    return {
      runId: this.snapshotValue.runId,
      dispatchRevision: this.snapshotValue.dispatchRevision,
    };
  }

  get isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this.snapshotValue.status);
  }

  markRunning(now = Date.now()): RunSnapshotV1 {
    if (this.isTerminal || this.snapshotValue.status === "cancelling") return this.snapshot;
    this.snapshotValue = {
      ...this.snapshotValue,
      revision: this.snapshotValue.revision + 1,
      status: "running",
      updatedAt: now,
    };
    return this.snapshot;
  }

  /** Reconcile requested settings with the validated, mode-clamped runtime configuration. */
  updateConfiguration(patch: RunConfigurationPatch, now = Date.now()): RunSnapshotV1 {
    if (this.isTerminal || this.snapshotValue.status === "cancelling") return this.snapshot;
    this.snapshotValue = {
      ...this.snapshotValue,
      ...patch,
      revision: this.snapshotValue.revision + 1,
      updatedAt: now,
    };
    return this.snapshot;
  }

  updateProgress(patch: RunProgressPatch, now = Date.now()): RunSnapshotV1 {
    if (this.isTerminal || this.snapshotValue.status === "cancelling") return this.snapshot;
    this.snapshotValue = {
      ...this.snapshotValue,
      ...patch,
      revision: this.snapshotValue.revision + 1,
      status: "running",
      updatedAt: now,
    };
    return this.snapshot;
  }

  /**
   * Reserve a monotonic envelope revision for a supplemental transcript event
   * that must not alter lifecycle phase/status (for example, a tab-policy
   * explanation emitted inside a privileged RPC).
   */
  recordSupplementalEvent(now = Date.now()): RunSnapshotV1 {
    if (this.isTerminal || this.snapshotValue.status === "cancelling") return this.snapshot;
    this.snapshotValue = {
      ...this.snapshotValue,
      revision: this.snapshotValue.revision + 1,
      updatedAt: now,
    };
    return this.snapshot;
  }

  requestCancellation(message = "Cancellation requested by user.", now = Date.now()): RunSnapshotV1 {
    if (this.isTerminal || this.snapshotValue.status === "cancelling") return this.snapshot;
    this.snapshotValue = {
      ...this.snapshotValue,
      revision: this.snapshotValue.revision + 1,
      dispatchRevision: this.snapshotValue.dispatchRevision + 1,
      status: "cancelling",
      phase: "cancelling",
      activeOperation: undefined,
      terminalMessage: message,
      updatedAt: now,
    };
    this.rootAbortController.abort(new DOMException(message, "AbortError"));
    return this.snapshot;
  }

  markTerminal(
    reason: RunTerminalReason,
    message: string,
    resultText?: string,
    now = Date.now(),
  ): RunSnapshotV1 {
    if (this.isTerminal) return this.snapshot;
    this.snapshotValue = {
      ...this.snapshotValue,
      revision: this.snapshotValue.revision + 1,
      dispatchRevision: this.snapshotValue.dispatchRevision + 1,
      status: statusForTerminalReason(reason),
      phase: "terminal",
      activeOperation: undefined,
      terminalReason: reason,
      terminalMessage: message,
      ...(resultText === undefined ? {} : { resultText }),
      updatedAt: now,
      endedAt: now,
    };
    if (!this.rootAbortController.signal.aborted && reason !== "succeeded") {
      this.rootAbortController.abort(new DOMException(message, "AbortError"));
    }
    return this.snapshot;
  }

  /**
   * Complete the user-visible result for the narrow `error` -> `done` event
   * sequence emitted by the orchestrator. This never changes terminal status,
   * reason, dispatch authority, or end time, and it is write-once: cancellation,
   * interruption, success, and later duplicate callbacks remain immutable.
   */
  enrichFailedTerminalResult(
    message: string,
    resultText: string,
    now = Date.now(),
  ): RunSnapshotV1 {
    if (this.snapshotValue.status !== "failed" || this.snapshotValue.resultText !== undefined) {
      return this.snapshot;
    }
    this.snapshotValue = {
      ...this.snapshotValue,
      revision: this.snapshotValue.revision + 1,
      terminalMessage: message,
      resultText,
      updatedAt: now,
    };
    return this.snapshot;
  }

  canDispatch(token: RunDispatchToken): boolean {
    return (
      !this.signal.aborted &&
      this.snapshotValue.status === "running" &&
      token.runId === this.snapshotValue.runId &&
      token.dispatchRevision === this.snapshotValue.dispatchRevision
    );
  }
}

let currentRunController: RunController | null = null;

export function beginRunController(options: BeginRunOptions): RunController {
  if (currentRunController && !currentRunController.isTerminal) {
    throw new Error("an authoritative run is already active");
  }
  currentRunController = new RunController(options);
  return currentRunController;
}

export function getCurrentRunController(): RunController | null {
  return currentRunController;
}

export function isAuthoritativeRun(controller: RunController): boolean {
  return currentRunController === controller;
}

export function requestCurrentRunCancellation(
  message?: string,
  now?: number,
): RunSnapshotV1 | null {
  if (!currentRunController || currentRunController.isTerminal) return null;
  return currentRunController.requestCancellation(message, now);
}

export function canCurrentRunDispatch(token: RunDispatchToken): boolean {
  return currentRunController?.canDispatch(token) ?? false;
}

export function resetRunControllerForTests(): void {
  currentRunController = null;
}
