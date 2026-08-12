import type { LogEvent } from "@/lib/agent/types";
import {
  getCurrentRunController,
  isAuthoritativeRun,
  type RunController,
} from "./run-controller";
import { redactKeyLeak } from "@/lib/agent/redact-shared";
import { redactLiveRunEvent, serializeEventTime } from "./run-event-projection";
import { persistRunSnapshot } from "./run-snapshot-store";

/**
 * Emit a non-lifecycle transcript event with the active run's identity and a
 * fresh monotonic revision. If an async producer supplies its originating
 * controller, a successor run can never inherit the predecessor's event.
 */
export function broadcastSupplementalRunEvent(
  event: LogEvent,
  originatingController?: RunController | null,
): void {
  const controller = getCurrentRunController();
  const safeEvent = redactLiveRunEvent(event);
  if (!controller || controller.isTerminal || controller.signal.aborted) {
    return;
  }
  if (originatingController !== undefined && (
    !originatingController || !isAuthoritativeRun(originatingController)
  )) return;
  const snapshot = controller.recordSupplementalEvent();
  void persistRunSnapshot(snapshot).catch(() => { /* best-effort */ });
  try {
    chrome.runtime.sendMessage({
      type: "AGENT_EVENT",
      event: safeEvent,
      runId: snapshot.runId,
      revision: snapshot.revision,
      time: serializeEventTime(),
    }).catch(() => { /* side panel may be closed */ });
  } catch {
    /* runtime unavailable during service-worker teardown */
  }
}

/**
 * Surface a service-worker-owned diagnostic when no run exists. Unlike run
 * events, these messages are constructed entirely from internal watchdog
 * state and cannot contain stored secrets. Heuristic redaction still protects
 * against accidentally embedding a credential-shaped value in a diagnostic.
 */
export function broadcastTrustedInternalWarning(message: string): void {
  const controller = getCurrentRunController();
  if (controller && !controller.isTerminal && !controller.signal.aborted) {
    broadcastSupplementalRunEvent({ type: "warn", message }, controller);
    return;
  }
  try {
    chrome.runtime.sendMessage({
      type: "AGENT_EVENT",
      event: { type: "warn", message: redactKeyLeak(message) },
      time: new Date().toTimeString().slice(0, 8),
    }).catch(() => {});
  } catch { /* runtime unavailable during teardown */ }
}
