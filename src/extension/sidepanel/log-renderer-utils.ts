import type { LogEvent } from "@/lib/agent/types";

/**
 * Format a token count with correct English pluralization.
 */
export function formatTokens(n: number): string {
  return `${n} ${n === 1 ? "token" : "tokens"}`;
}

/**
 * Validate an incoming AGENT_EVENT payload at the message-passing trust boundary.
 */
export function isValidAgentEvent(ev: unknown): ev is LogEvent {
  if (typeof ev !== "object" || ev === null) return false;
  const e = ev as Record<string, unknown>;
  if (typeof e.type !== "string") return false;
  switch (e.type) {
    case "run-start":
      return typeof e.task === "string";
    case "planner-step":
      return typeof e.step === "number" && typeof e.decision === "string";
    case "navigator-step-start":
      return typeof e.step === "number";
    case "state":
      return typeof e.step === "number" && typeof e.elementCount === "number" && typeof e.pageInfo === "string";
    case "thinking":
      return typeof e.step === "number";
    case "llm-call-start":
      return typeof e.step === "number" && typeof e.callId === "string" &&
        typeof e.role === "string" && typeof e.attempt === "number" &&
        typeof e.startedAt === "number" && typeof e.prompt === "object" && e.prompt !== null;
    case "llm-call-progress":
      return typeof e.step === "number" && typeof e.callId === "string" &&
        typeof e.role === "string" && typeof e.attempt === "number" &&
        typeof e.outputChars === "number" && typeof e.chunkCount === "number" &&
        typeof e.elapsedMs === "number";
    case "llm-call-end":
      return typeof e.step === "number" && typeof e.callId === "string" &&
        typeof e.role === "string" && typeof e.attempt === "number" &&
        typeof e.status === "string" && typeof e.durationMs === "number" &&
        typeof e.outputChars === "number";
    case "judge":
      return typeof e.step === "number" && typeof e.stage === "string";
    case "action":
      return typeof e.step === "number" && typeof e.index === "number" && typeof e.total === "number" && typeof e.name === "string";
    case "action-result":
      return typeof e.step === "number" && typeof e.name === "string" && typeof e.success === "boolean" && typeof e.message === "string";
    case "budget-warning":
      return typeof e.step === "number" && typeof e.pct === "number";
    case "loop-warning":
      return typeof e.step === "number" && typeof e.count === "number";
    case "compaction":
      return typeof e.step === "number" && typeof e.compactedCount === "number";
    case "challenge_detected":
      return typeof e.step === "number" && typeof e.kind === "string" && typeof e.message === "string";
    case "takeover":
      return typeof e.step === "number" && typeof e.reason === "string";
    case "paused":
      return typeof e.step === "number";
    case "resumed":
      return typeof e.step === "number";
    case "done":
      return typeof e.step === "number" && typeof e.success === "boolean" && typeof e.text === "string";
    case "error":
      return typeof e.step === "number" && typeof e.message === "string" && typeof e.recoverable === "boolean";
    case "info":
      return typeof e.message === "string";
    case "warn":
      return typeof e.message === "string";
    case "cost":
      return typeof e.step === "number" && typeof e.tokensIn === "number" && typeof e.tokensOut === "number" && typeof e.costUsd === "number" && typeof e.model === "string";
    case "heartbeat":
      return typeof e.step === "number" && typeof e.ts === "number";
    default:
      return false;
  }
}
