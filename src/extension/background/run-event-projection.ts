import type { LogEvent } from "@/lib/agent/types";
import { redactLiveSecretValue } from "@/lib/agent/secrets";
import type { RunUsage } from "./state-store";
import type { RunController, RunSnapshotV1, RunTerminalReason } from "./run-controller";

function redactLiveEventValue(value: unknown, key?: string): unknown {
  // Event discriminants are protocol structure, not user/provider text. They
  // must remain intact so redaction can never corrupt admission or rendering.
  if (key === "type" && typeof value === "string") return value;
  if (typeof value === "string") return redactLiveSecretValue(value);
  if (Array.isArray(value)) return value.map((nested) => redactLiveEventValue(nested));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([nestedKey, nested]) => [nestedKey, redactLiveEventValue(nested, nestedKey)]),
    );
  }
  return value;
}

/**
 * Clone and synchronously redact a transcript event. Event payload strings
 * are data-bearing, while the `type` discriminant is preserved as structure.
 */
/**
 * Serialize an event timestamp for AGENT_EVENT envelopes. `toTimeString()`'s
 * HH:MM:SS prefix is locale-independent (unlike `toLocaleTimeString`, which
 * can emit "24:00:00" or vary by locale), so every producer renders the same
 * deterministic wall-clock time string for the same instant.
 */
export function serializeEventTime(now = new Date()): string {
  return now.toTimeString().slice(0, 8);
}

export function redactLiveRunEvent(event: LogEvent): LogEvent {
  return redactLiveEventValue(event) as LogEvent;
}

/** Synchronous projection for every RunController snapshot egress. */
export function redactLiveRunSnapshot(snapshot: RunSnapshotV1): RunSnapshotV1 {
  return {
    ...snapshot,
    task: redactLiveSecretValue(snapshot.task),
    ...(snapshot.activeOperation === undefined
      ? {}
      : { activeOperation: redactLiveSecretValue(snapshot.activeOperation) }),
    ...(snapshot.terminalMessage === undefined
      ? {}
      : { terminalMessage: redactLiveSecretValue(snapshot.terminalMessage) }),
    ...(snapshot.resultText === undefined
      ? {}
      : { resultText: redactLiveSecretValue(snapshot.resultText) }),
    ...(snapshot.usage
      ? {
          usage: {
            ...snapshot.usage,
            ...(snapshot.usage.model === undefined
              ? {}
              : { model: redactLiveSecretValue(snapshot.usage.model) }),
          },
        }
      : {}),
  };
}

function terminalReasonFromError(event: Extract<LogEvent, { type: "error" }>): RunTerminalReason {
  const code = event.code?.toLowerCase() ?? "";
  if (code.includes("empty")) return "empty_output";
  if (code.includes("reasoning")) return "reasoning_only";
  if (code.includes("timeout") || code.includes("deadline") || code.includes("stall")) return "deadline";
  if (code.includes("protocol") || code.includes("parse") || code.includes("malformed")) return "protocol_error";
  if (code.includes("provider") || code.includes("auth") || code.includes("rate")) return "provider_error";
  if (code.includes("policy") || code.includes("blocked")) return "policy_block";
  return "failed";
}

export function projectRunEvent(
  controller: RunController,
  event: LogEvent,
  usage?: RunUsage,
): RunSnapshotV1 {
  // A cancellation freezes the event projection before any event-specific
  // branch can enrich usage, advance a step, or turn a late `done(success)`
  // into a successful terminal snapshot. The bridge performs the matching
  // admission check before it records the event in history.
  if (
    controller.snapshot.status === "cancelling" ||
    controller.snapshot.status === "cancelled"
  ) return controller.snapshot;

  // Agent-loop events are zero-based implementation indices. Snapshots are a
  // user-facing contract and align with RunBuilder.stepCount (first step = 1).
  const displayStep = (step: number): number => step + 1;

  switch (event.type) {
    case "run-start":
      return controller.updateProgress({ phase: "starting", step: 0, activeOperation: "Starting run", usage });
    case "planner-step":
      return controller.updateProgress({
        phase: "reasoning",
        step: displayStep(event.step),
        activeOperation: event.goal ? "Planning next goal" : "Planning",
        usage,
      });
    case "navigator-step-start":
      return controller.updateProgress({
        phase: "observing",
        step: displayStep(event.step),
        activeOperation: "Reading the page",
        usage,
      });
    case "state":
      return controller.updateProgress({
        phase: "reasoning",
        step: displayStep(event.step),
        activeOperation: "Choosing the next action",
        usage,
      });
    case "thinking":
      return controller.updateProgress({
        phase: "reasoning",
        step: displayStep(event.step),
        // The PERSISTED snapshot deliberately does not retain the model's raw
        // reasoning (it can echo page content) — the live chat area renders
        // the full redacted thinking via the AGENT_EVENT broadcast instead.
        activeOperation: "Reasoning",
        usage,
      });
    case "action":
      return controller.updateProgress({
        phase: "acting",
        step: displayStep(event.step),
        activeOperation: event.description || event.name,
        usage,
      });
    case "action-result":
      return controller.updateProgress({
        phase: "observing",
        step: displayStep(event.step),
        activeOperation: "Verifying the action",
        usage,
      });
    case "paused":
    case "takeover":
      return controller.updateProgress({
        phase: "acting",
        step: displayStep(event.step),
        activeOperation: "Waiting for you",
        usage,
      });
    case "resumed":
      return controller.updateProgress({
        phase: "observing",
        step: displayStep(event.step),
        activeOperation: "Resuming",
        usage,
      });
    case "done":
      if (controller.isTerminal && !event.success) {
        return controller.enrichFailedTerminalResult(event.text, event.text);
      }
      if (controller.isTerminal) return controller.snapshot;
      return controller.markTerminal(
        event.success ? "succeeded" : controller.signal.aborted ? "cancelled" : "failed",
        event.text,
        event.text,
      );
    case "error":
      if (!event.recoverable) {
        return controller.markTerminal(
          controller.signal.aborted ? "cancelled" : terminalReasonFromError(event),
          event.message,
        );
      }
      return controller.updateProgress({
        phase: "reasoning",
        step: displayStep(event.step),
        activeOperation: event.recovery || "Recovering from an error",
        usage,
      });
    case "cost":
      return controller.updateProgress({ step: displayStep(event.step), usage });
    case "heartbeat":
      return controller.updateProgress({ step: displayStep(event.step), usage });
    case "budget-warning":
    case "loop-warning":
    case "compaction":
    case "challenge_detected":
      return controller.updateProgress({ step: displayStep(event.step), usage });
    case "info":
    case "warn":
      return controller.updateProgress({ usage });
  }
}
