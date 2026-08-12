import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  beginRunController,
  resetRunControllerForTests,
} from "../src/extension/background/run-controller";
import {
  primeLiveSecretRedaction,
  resetLiveSecretRedactionForTests,
} from "../src/lib/agent/secrets";
import { resetRunSnapshotWriteChainForTests } from "../src/extension/background/run-snapshot-store";
import { broadcastSupplementalRunEvent } from "../src/extension/background/run-event-broadcast";

describe("supplemental run event broadcast", () => {
  const sendMessage = vi.fn(async () => undefined);

  beforeEach(() => {
    resetRunControllerForTests();
    resetRunSnapshotWriteChainForTests();
    sendMessage.mockClear();
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: {
        session: {
          get: vi.fn(async () => ({ open_cowork_secrets: [] })),
          set: vi.fn(async () => undefined),
        },
      },
    });
  });

  afterEach(() => {
    resetRunControllerForTests();
    resetLiveSecretRedactionForTests();
    vi.unstubAllGlobals();
  });

  test("stamps a redacted monotonic envelope and drops a predecessor event", async () => {
    await primeLiveSecretRedaction();
    const old = beginRunController({ runId: "old", task: "task", maxSteps: 1, mode: "standard" });
    old.markRunning();
    broadcastSupplementalRunEvent({
      type: "warn",
      message: "Bearer predecessorSecret123456",
    }, old);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "AGENT_EVENT",
      runId: "old",
      revision: expect.any(Number),
      event: expect.objectContaining({ message: "Bearer [REDACTED]" }),
    }));

    old.markTerminal("cancelled", "stopped");
    const successor = beginRunController({ runId: "new", task: "task", maxSteps: 1, mode: "standard" });
    successor.markRunning();
    broadcastSupplementalRunEvent({ type: "warn", message: "late old warning" }, old);

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
