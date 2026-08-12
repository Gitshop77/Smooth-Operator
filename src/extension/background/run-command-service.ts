/** Typed RUN/STOP/STATUS application service for the background authority. */

import type { AgentMode } from "@/lib/agent/modes";
import { redactLiveSecretValue } from "@/lib/agent/secrets";
import {
  DEFAULT_MAX_STEPS,
  DEFAULT_MODE,
  discardReservedManualRun,
  isRunStarting,
  requestRunStartCancellation,
  reserveManualRunAuthority,
  setRunStarting,
  startRun,
} from "./agent-bridge";
import { KNOWN_MODES } from "./message-types";
import {
  getCurrentRunController,
  requestCurrentRunCancellation,
} from "./run-controller";
import { redactLiveRunSnapshot } from "./run-event-projection";
import { waitForRunRecoveryAudit } from "./run-recovery-gate";
import {
  getPersistedRunSnapshot,
  persistRunSnapshot,
} from "./run-snapshot-store";
import { getRunState, saveRunState } from "./state-store";

export interface RunCommand {
  task: string;
  maxSteps?: number;
  mode?: AgentMode;
}

export type RunCommandResponse = (response?: unknown) => void;

export interface RunCommandService {
  handleRun(command: RunCommand, respond: RunCommandResponse): boolean;
  handleStop(respond: RunCommandResponse): boolean;
  handleStatus(respond: RunCommandResponse): boolean;
}

function bindCommand(
  respond: RunCommandResponse,
  command: () => Promise<void>,
): boolean {
  void command().catch((error) => {
    respond({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
}

export class BackgroundRunCommandService implements RunCommandService {
  handleRun(command: RunCommand, respond: RunCommandResponse): boolean {
    if (isRunStarting()) {
      respond({ ok: false, error: "already starting" });
      return false;
    }
    if (typeof command.task !== "string" || command.task.trim().length === 0) {
      respond({ ok: false, error: "task required" });
      return false;
    }
    const maxTaskLength = 10_000;
    if (command.task.length > maxTaskLength) {
      respond({
        ok: false,
        error: `Task too long (${command.task.length} chars, max ${maxTaskLength})`,
      });
      return false;
    }
    const maxSteps = typeof command.maxSteps === "number" &&
      Number.isFinite(command.maxSteps) && command.maxSteps >= 1
      ? Math.max(1, Math.min(Math.floor(command.maxSteps), 1000))
      : DEFAULT_MAX_STEPS;
    const mode = typeof command.mode === "string" && KNOWN_MODES.has(command.mode)
      ? command.mode
      : DEFAULT_MODE;
    setRunStarting(true);
    try {
      reserveManualRunAuthority({ task: command.task, maxSteps, mode });
    } catch (error) {
      setRunStarting(false);
      respond({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    let responded = false;
    void (async () => {
      try {
        await waitForRunRecoveryAudit();
        const existing = await getRunState();
        if (existing?.active) {
          await discardReservedManualRun(
            "A previous run is still being recovered.",
          );
          respond({ ok: false, error: "already running" });
          responded = true;
          return;
        }
        respond({ ok: true });
        responded = true;
        await startRun({ task: command.task, maxSteps, mode });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await discardReservedManualRun(message).catch(() => {});
        setRunStarting(false);
        if (!responded) respond({ ok: false, error: message });
      }
    })();
    return true;
  }

  handleStop(respond: RunCommandResponse): boolean {
    return bindCommand(respond, async () => {
      const current = getCurrentRunController();
      const requested = requestCurrentRunCancellation("Stop requested by user.");
      const snapshot = requested ?? current?.snapshot ?? null;
      await waitForRunRecoveryAudit();
      const cancellationTasks: Promise<unknown>[] = requested
        ? [
            persistRunSnapshot(requested),
            import("./tab-manager").then(({ broadcastRunCancellation }) =>
              broadcastRunCancellation(requested)),
          ]
        : [];
      const state = await getRunState();
      if (state?.active || isRunStarting()) {
        requestRunStartCancellation();
        cancellationTasks.push(saveRunState({ abortRequested: true }));
      }
      await Promise.allSettled(cancellationTasks);
      const safeSnapshot = snapshot ? redactLiveRunSnapshot(snapshot) : null;
      respond({
        ok: true,
        status: snapshot ? snapshot.status : "idle",
        ...(safeSnapshot ? { snapshot: safeSnapshot } : {}),
      });
    });
  }

  handleStatus(respond: RunCommandResponse): boolean {
    return bindCommand(respond, async () => {
      await waitForRunRecoveryAudit();
      const state = await getRunState();
      const liveSnapshot = getCurrentRunController()?.snapshot;
      const snapshot = liveSnapshot ?? await getPersistedRunSnapshot();
      const running = snapshot
        ? snapshot.status === "starting" || snapshot.status === "running" ||
          snapshot.status === "cancelling"
        : !!state?.active;
      const safeState = state
        ? { ...state, task: redactLiveSecretValue(state.task) }
        : state;
      respond({
        running,
        state: safeState,
        snapshot: snapshot ? redactLiveRunSnapshot(snapshot) : snapshot,
      });
    });
  }
}

export const runCommandService: RunCommandService =
  new BackgroundRunCommandService();
