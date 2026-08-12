/**
 * Authoritative side-panel projection of the background-owned run snapshot.
 *
 * Snapshots are the source of truth.  Event envelopes are transcript facts
 * only (ADR-005): they are admitted for rendering when they belong to the
 * current run and do not go backwards, but they never mutate the lifecycle
 * projection.  A versioned event is deliberately not a state mutation; its
 * snapshot arrives via STATUS/STOP or the persisted snapshot channel.
 */

import type { LogEvent } from "@/lib/agent/types";
import { isRunSnapshotV1 } from "@/lib/agent/run-lifecycle-contract";
import type {
  RunLifecycleStatus,
  RunPhase,
  RunSnapshotV1,
} from "@/extension/background/run-controller";
import type { RunUsage } from "@/extension/background/state-store-utils";

export interface RunViewState {
  snapshot?: RunSnapshotV1;
  task: string;
  status: RunLifecycleStatus | "idle";
  phase?: RunPhase;
  step?: number;
  activeOperation?: string;
  usage?: RunUsage;
  terminalMessage?: string;
  resultText?: string;
}

export interface EventVersion {
  runId?: string;
  revision?: number;
}

type Listener = (state: RunViewState) => void;

const TERMINAL = new Set<RunViewState["status"]>([
  "succeeded", "failed", "cancelled", "interrupted",
]);

let state: RunViewState = { task: "", status: "idle" };
// Snapshot and transcript envelopes are independently delivered streams. A
// snapshot revision is not proof that the event with that revision was seen.
let lastEventRevision = -1;
let eventRunId: string | undefined;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) {
    // Isolate subscribers: one throwing listener must not abort the remaining
    // listeners or surface an uncaught error inside a Chrome event callback.
    try {
      listener(state);
    } catch (error) {
      console.error("[run-store] subscriber threw during emit:", error);
    }
  }
}

function setState(next: RunViewState): void {
  state = next;
  emit();
}

export function getRunViewState(): RunViewState {
  return state;
}

export function subscribeRunView(listener: Listener): () => void {
  listeners.add(listener);
  // Run the initial synchronous notification off the current stack so a
  // throwing subscriber cannot break module wiring at registration time.
  queueMicrotask(() => {
    if (listeners.has(listener)) {
      try {
        listener(state);
      } catch (error) {
        console.error("[run-store] subscriber threw during initial notify:", error);
      }
    }
  });
  return () => listeners.delete(listener);
}

export function isTerminalStatus(status: RunViewState["status"]): boolean {
  return TERMINAL.has(status);
}

export function isActiveStatus(status: RunViewState["status"]): boolean {
  return status === "starting" || status === "running" || status === "cancelling";
}

/** Hydrate from a background snapshot, refusing an older projection. */
export function hydrateRunSnapshot(snapshot: unknown): boolean {
  if (!isRunSnapshotV1(snapshot)) return false;
  const current = state.snapshot;
  if (current) {
    if (snapshot.runId === current.runId && snapshot.revision < current.revision) return false;
    // A new run may replace a terminal run, but a DIFFERENT run that started
    // before the current one is always stale — even when the current run is
    // already terminal (a stale cross-run message must never resurrect an
    // older run's snapshot after a successor terminal).
    if (snapshot.runId !== current.runId && snapshot.startedAt < current.startedAt) return false;
  }
  // Event revisions are scoped to a run. Do not advance the event cursor from
  // a snapshot: storage can arrive before the matching AGENT_EVENT, and that
  // transcript fact must still render exactly once.
  const sameEventRun = eventRunId === snapshot.runId;
  eventRunId = snapshot.runId;
  if (!sameEventRun) lastEventRevision = -1;
  setState({
    snapshot,
    task: snapshot.task,
    status: snapshot.status,
    phase: snapshot.phase,
    step: snapshot.step,
    activeOperation: snapshot.activeOperation,
    usage: snapshot.usage,
    terminalMessage: snapshot.terminalMessage,
    resultText: snapshot.resultText,
  });
  return true;
}

/** Optimistic projection while a RUN request is in flight. */
export function beginLocalRun(task: string): void {
  eventRunId = undefined;
  lastEventRevision = -1;
  setState({ task, status: "starting", phase: "starting", step: 0 });
}

export function failLocalRun(message: string): void {
  // The optimistic projection failed; drop any lingering snapshot so the
  // "failed" status can never transiently coexist with a snapshot that
  // claims a running/active state.
  setState({
    ...state,
    snapshot: undefined,
    status: "failed",
    phase: "terminal",
    terminalMessage: message,
  });
}

export function requestLocalCancellation(): void {
  if (!isActiveStatus(state.status)) return;
  setState({ ...state, status: "cancelling", phase: "cancelling" });
}

/** Compatibility projection for STATUS replies from workers without snapshots. */
export function hydrateLegacyStatus(running: boolean): void {
  if (state.snapshot) {
    // A mixed-version worker can acknowledge an idle STOP without carrying a
    // V1 terminal snapshot. Treat that response as a compatibility terminal
    // boundary so the panel is reusable instead of remaining cancelling.
    if (!running && isActiveStatus(state.status)) {
      setState({ task: state.task, status: "idle" });
    }
    return;
  }
  if (running) {
    setState({ ...state, status: state.status === "cancelling" ? "cancelling" : "running" });
  } else if (isActiveStatus(state.status)) {
    setState({ ...state, status: "idle", phase: undefined });
  }
}

/**
 * Older workers emitted this internal cancellation pair without an envelope.
 * Once a V1 snapshot owns the panel, it could belong to a predecessor and has
 * no identity with which to prove otherwise. Other unversioned events retain
 * their transcript compatibility.
 */
function isUnversionedCancellationTranscript(event: LogEvent): boolean {
  return (event.type === "info" && event.message === "Agent stopped by user.") ||
    (event.type === "done" && !event.success && event.text === "Agent stopped by user.");
}

/**
 * Admit one event envelope for transcript rendering. `false` means it is
 * stale/cross-run and must not reach either the transcript or lifecycle UI.
 *
 * Events never mutate lifecycle state (ADR-005): the panel
 * renders strictly from the snapshot projection, and the caller reconciles
 * STATUS after every admitted event so the authoritative snapshot converges.
 */
export function applyRunEvent(event: LogEvent, version: EventVersion = {}): boolean {
  const versioned = typeof version.runId === "string" && Number.isFinite(version.revision);
  if (versioned) {
    const revision = version.revision as number;
    const knownRunId = state.snapshot?.runId ?? eventRunId;
    if (knownRunId && version.runId !== knownRunId) return false;
    if (revision <= lastEventRevision) return false;
    eventRunId = version.runId;
    lastEventRevision = revision;
    return true;
  }

  // Unversioned transcript/cost events remain renderable during the migration
  // window, but the unsafe unversioned cancellation signature is dropped and
  // no unversioned event mutates the lifecycle projection.
  if (isUnversionedCancellationTranscript(event)) return false;
  return true;
}

/** Test-only reset; normal panels are fresh extension documents. */
export function resetRunStoreForTests(): void {
  state = { task: "", status: "idle" };
  lastEventRevision = -1;
  eventRunId = undefined;
  listeners.clear();
}
