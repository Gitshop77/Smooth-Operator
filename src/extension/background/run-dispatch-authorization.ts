import type { PrivilegedDispatchToken } from "./message-types";
import {
  canCurrentRunDispatch,
  getCurrentRunController,
  type RunController,
} from "./run-controller";
import { waitForRunRecoveryAudit } from "./run-recovery-gate";

export type RunScopedAuthorization =
  | { ok: true; controller?: RunController }
  | { ok: false; error: string };

/**
 * Shared authority boundary for every run-scoped runtime RPC. An in-memory
 * controller is intentionally the only source of live dispatch authority;
 * after a worker restart, an old token must never become a legacy untokened
 * request merely because the controller was lost.
 */
export async function authorizeRunScopedDispatch(
  supplied: PrivilegedDispatchToken | undefined,
): Promise<RunScopedAuthorization> {
  try {
    await waitForRunRecoveryAudit();
  } catch {
    return { ok: false, error: "run recovery audit did not complete safely" };
  }
  const controller = getCurrentRunController();
  if (!controller) {
    return { ok: false, error: supplied === undefined
      ? "missing run dispatch token"
      : "stale run dispatch token" };
  }
  if (!supplied || !canCurrentRunDispatch(supplied)) {
    return { ok: false, error: "run is not authorized to dispatch actions" };
  }
  return { ok: true, controller };
}
