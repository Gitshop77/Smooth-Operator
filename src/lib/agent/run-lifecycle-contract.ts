import type { AgentMode } from "./modes";

export const RUN_LIFECYCLE_STATUSES = [
  "starting",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type RunLifecycleStatus = (typeof RUN_LIFECYCLE_STATUSES)[number];

export const RUN_PHASES = [
  "starting",
  "connecting",
  "observing",
  "reasoning",
  "parsing",
  "acting",
  "cancelling",
  "terminal",
] as const;

export type RunPhase = (typeof RUN_PHASES)[number];

export const RUN_TERMINAL_REASONS = [
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "empty_output",
  "reasoning_only",
  "deadline",
  "provider_error",
  "protocol_error",
  "policy_block",
] as const;

export type RunTerminalReason = (typeof RUN_TERMINAL_REASONS)[number];

export interface RunSnapshotUsage {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  model: string;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cachedWriteInputTokens?: number;
}

export interface RunSnapshotV1 {
  version: 1;
  runId: string;
  revision: number;
  dispatchRevision: number;
  task: string;
  maxSteps: number;
  mode: AgentMode;
  status: RunLifecycleStatus;
  phase: RunPhase;
  step: number;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  activeOperation?: string;
  terminalReason?: RunTerminalReason;
  terminalMessage?: string;
  resultText?: string;
  usage?: RunSnapshotUsage;
}

const LIFECYCLE_STATUS_SET: ReadonlySet<string> = new Set(RUN_LIFECYCLE_STATUSES);
const PHASE_SET: ReadonlySet<string> = new Set(RUN_PHASES);
const TERMINAL_REASON_SET: ReadonlySet<string> = new Set(RUN_TERMINAL_REASONS);
const MODE_SET: ReadonlySet<string> = new Set(["restricted", "standard", "full_agentic"]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isRunSnapshotUsage(value: unknown): value is RunSnapshotUsage {
  if (!value || typeof value !== "object") return false;
  const usage = value as Record<string, unknown>;
  return (
    isFiniteNumber(usage.tokensIn) &&
    isFiniteNumber(usage.tokensOut) &&
    isFiniteNumber(usage.costUsd) &&
    typeof usage.model === "string" &&
    isOptionalFiniteNumber(usage.reasoningTokens) &&
    isOptionalFiniteNumber(usage.cachedInputTokens) &&
    isOptionalFiniteNumber(usage.cachedWriteInputTokens)
  );
}

export function isRunLifecycleStatus(value: unknown): value is RunLifecycleStatus {
  return typeof value === "string" && LIFECYCLE_STATUS_SET.has(value);
}

export function isRunPhase(value: unknown): value is RunPhase {
  return typeof value === "string" && PHASE_SET.has(value);
}

export function isRunTerminalReason(value: unknown): value is RunTerminalReason {
  return typeof value === "string" && TERMINAL_REASON_SET.has(value);
}

/** Strict decoder shared by storage and every UI snapshot admission boundary. */
export function isRunSnapshotV1(value: unknown): value is RunSnapshotV1 {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  return (
    snapshot.version === 1 &&
    typeof snapshot.runId === "string" && snapshot.runId.length > 0 &&
    isNonNegativeInteger(snapshot.revision) &&
    isNonNegativeInteger(snapshot.dispatchRevision) &&
    typeof snapshot.task === "string" &&
    Number.isSafeInteger(snapshot.maxSteps) && (snapshot.maxSteps as number) >= 1 &&
    typeof snapshot.mode === "string" && MODE_SET.has(snapshot.mode) &&
    isRunLifecycleStatus(snapshot.status) &&
    isRunPhase(snapshot.phase) &&
    isNonNegativeInteger(snapshot.step) &&
    isFiniteNumber(snapshot.startedAt) &&
    isFiniteNumber(snapshot.updatedAt) &&
    isOptionalFiniteNumber(snapshot.endedAt) &&
    isOptionalString(snapshot.activeOperation) &&
    (snapshot.terminalReason === undefined || isRunTerminalReason(snapshot.terminalReason)) &&
    isOptionalString(snapshot.terminalMessage) &&
    isOptionalString(snapshot.resultText) &&
    (snapshot.usage === undefined || isRunSnapshotUsage(snapshot.usage))
  );
}
