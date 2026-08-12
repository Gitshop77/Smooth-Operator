import type { RunDispatchToken } from "./run-controller";
import {
  clearRunStateForRun,
  getRunState,
  initializeRunStateForRun,
  saveRunStateForRun,
  RUN_STATE_KEY,
  type RunState,
} from "./state-store";

export interface RunAbortWiring {
  onStorageChanged: (
    changes: { [key: string]: chrome.storage.StorageChange },
    area: string,
  ) => void;
}

/** Typed authority port for operational state belonging to one live run. */
export class RunSessionStateService {
  async readForRun(identity: Pick<RunDispatchToken, "runId">): Promise<RunState | null> {
    const state = await getRunState();
    return state?.runId === identity.runId ? state : null;
  }

  async initialize(state: RunState & { runId: string }): Promise<void> {
    await initializeRunStateForRun(state);
  }

  async patch(
    identity: Pick<RunDispatchToken, "runId">,
    patch: Omit<Partial<RunState>, "runId" | "version">,
  ): Promise<void> {
    await saveRunStateForRun(identity.runId, patch);
  }

  async clear(identity: Pick<RunDispatchToken, "runId">): Promise<void> {
    await clearRunStateForRun(identity.runId);
  }

  wireAbort(
    controller: AbortController,
    identity: Pick<RunDispatchToken, "runId">,
  ): RunAbortWiring {
    const onStorageChanged: RunAbortWiring["onStorageChanged"] = (changes, area) => {
      if (area !== "session") return;
      const next = changes[RUN_STATE_KEY]?.newValue as Record<string, unknown> | undefined;
      if (next?.runId === identity.runId && next.abortRequested === true) {
        controller.abort();
      }
    };
    chrome.storage.onChanged.addListener(onStorageChanged);
    return { onStorageChanged };
  }
}

export const runSessionState = new RunSessionStateService();
