import { describe, expect, test } from "vitest";
import {
  setRunRecoveryAudit,
  waitForRunRecoveryAudit,
} from "../src/extension/background/run-recovery-gate";

describe("run recovery gate", () => {
  test("preserves startup audit rejection for every admission waiter", async () => {
    const failure = new Error("orphan authority could not be audited");
    setRunRecoveryAudit(Promise.reject(failure));

    await expect(waitForRunRecoveryAudit()).rejects.toBe(failure);
    await expect(waitForRunRecoveryAudit()).rejects.toBe(failure);
  });
});
