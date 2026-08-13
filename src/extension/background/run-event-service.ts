import type { LogEvent } from "@/lib/agent/types";
import type { RunBuilder } from "@/lib/agent/run-history";
import {
  addCostEvent,
  zeroRunUsage,
  type RunState,
  type RunUsage,
} from "./state-store";
import {
  isAuthoritativeRun,
  type RunController,
  type RunTerminalReason,
} from "./run-controller";
import { projectRunEvent, redactLiveRunEvent, serializeEventTime } from "./run-event-projection";
import { persistRunSnapshot } from "./run-snapshot-store";
import { runSessionState } from "./run-session-state";

const SWALLOW_CLOSED_PORT = (): void => {};

/** Owns admitted event projection, persistence, broadcast, and late-event rejection. */
export class RunEventService {
  private runState: RunState | null = null;
  private usageAccum: RunUsage | undefined;
  private finished = false;
  private cancellationTranscriptSent = false;
  private succeeded = false;
  /** A nonrecoverable error terminalizes immediately, but the loop's canonical
   * next event is `done(false)`, which supplies the user-facing result text. */
  private awaitingFailedDone = false;

  constructor(
    private readonly controller: RunController,
    private readonly runBuilder: RunBuilder,
  ) {}

  get runSucceeded(): boolean {
    return this.succeeded;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  get currentStep(): number {
    return this.runState?.step ?? 0;
  }

  setRunState(state: RunState): void {
    this.runState = state;
  }

  markFinished(): void {
    this.finished = true;
  }

  terminalize(reason: RunTerminalReason, message: string): void {
    if (!this.controller.isTerminal) this.controller.markTerminal(reason, message);
  }

  readonly emit = (event: LogEvent): void => {
    const isFailedDoneEnrichment =
      this.awaitingFailedDone &&
      event.type === "done" &&
      !event.success &&
      this.controller.snapshot.status === "failed" &&
      this.controller.snapshot.resultText === undefined;
    if (
      this.finished ||
      (this.controller.isTerminal && !isFailedDoneEnrichment) ||
      this.controller.snapshot.status === "cancelling" ||
      this.controller.snapshot.status === "cancelled" ||
      !isAuthoritativeRun(this.controller)
    ) return;

    const safeEvent = redactLiveRunEvent(event);
    // Stream progress is intentionally ephemeral: it animates the open panel,
    // but persisting several updates per second would bloat run history and
    // cause needless storage writes. The terminal call event retains duration,
    // output size, tokens, model, and status as the durable audit record.
    const ephemeralProgress = safeEvent.type === "llm-call-progress";
    const nextUsage = safeEvent.type === "cost"
      ? addCostEvent(this.usageAccum ?? zeroRunUsage(), safeEvent)
      : this.usageAccum;
    const snapshot = projectRunEvent(this.controller, safeEvent, nextUsage);
    if (!ephemeralProgress) this.runBuilder.addEvent(safeEvent);
    if (safeEvent.type === "error" && !safeEvent.recoverable && snapshot.status === "failed") {
      this.awaitingFailedDone = true;
    } else if (isFailedDoneEnrichment) {
      this.awaitingFailedDone = false;
    }
    if (safeEvent.type === "done" && safeEvent.success && snapshot.status === "succeeded") {
      this.succeeded = true;
    }
    if (safeEvent.type === "cost") {
      this.usageAccum = nextUsage;
      if (this.runState && !this.finished) {
        void runSessionState.patch(this.controller.dispatchToken, { usage: this.usageAccum }).catch(() => {});
      }
    }
    if (!ephemeralProgress) void persistRunSnapshot(snapshot).catch(() => {});
    chrome.runtime.sendMessage({
      type: "AGENT_EVENT",
      event: safeEvent,
      runId: snapshot.runId,
      revision: snapshot.revision,
      time: serializeEventTime(),
    }).catch(SWALLOW_CLOSED_PORT);

    if (safeEvent.type === "navigator-step-start" && this.runState && !this.finished) {
      this.runState.step = safeEvent.step;
      void runSessionState.patch(this.controller.dispatchToken, { step: safeEvent.step }).catch(() => {});
    }
  };

  /** Transcript-only cancellation feedback; lifecycle/history remain controller-owned. */
  sendCancellationTranscript(): void {
    if (this.cancellationTranscriptSent || !isAuthoritativeRun(this.controller)) return;
    this.cancellationTranscriptSent = true;
    const time = serializeEventTime();
    const baseRevision = this.controller.snapshot.revision;
    for (const [offset, event] of [
      { type: "info", message: "Agent stopped by user." } as const,
      { type: "done", step: this.currentStep, success: false, text: "Agent stopped by user." } as const,
    ].entries()) {
      try {
        chrome.runtime.sendMessage({
          type: "AGENT_EVENT",
          event,
          runId: this.controller.snapshot.runId,
          revision: baseRevision + offset + 1,
          time,
        }).catch(SWALLOW_CLOSED_PORT);
      } catch {
        /* runtime unavailable during teardown */
      }
    }
  }
}
