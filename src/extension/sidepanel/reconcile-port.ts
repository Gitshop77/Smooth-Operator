/** Neutral event-to-snapshot reconciliation port for side-panel modules. */

export type AgentEventReconciler = () => void;

let reconcileAgentEvent: AgentEventReconciler | null = null;

/** Controls owns reconciliation and registers its implementation here. */
export function registerAgentEventReconciler(
  reconciler: AgentEventReconciler,
): void {
  reconcileAgentEvent = reconciler;
}

/** Event rendering requests reconciliation without importing controls. */
export function requestAgentEventReconciliation(): void {
  reconcileAgentEvent?.();
}
