import { describe, expect, test, vi } from "vitest";
import {
  candidateCapabilityPolicy,
  createAuditedCapabilityPolicy,
  currentCapabilityPolicy,
  legacyCapabilityPolicy,
  type CapabilityPolicy,
  type CapabilityPolicyMismatchAudit,
} from "../src/lib/agent/capability-policy";

describe("CapabilityPolicy migration seam", () => {
  test("the legacy adapter preserves allowed, denied, confirmation, and unknown behavior", () => {
    expect(legacyCapabilityPolicy.decide({
      actionType: "click",
      mode: "restricted",
      enforcementPoint: "loop-action-queue",
    })).toEqual({ allowed: true, requiresConfirmation: false });
    expect(legacyCapabilityPolicy.decide({
      actionType: "set_cookie",
      mode: "standard",
      enforcementPoint: "privileged-effect",
    })).toEqual({ allowed: true, requiresConfirmation: true });
    expect(legacyCapabilityPolicy.decide({
      actionType: "evaluate",
      mode: "standard",
      enforcementPoint: "loader-step",
    })).toMatchObject({ allowed: false, requiresConfirmation: false });
    expect(legacyCapabilityPolicy.decide({
      actionType: "future_unreviewed_action",
      mode: "full_agentic",
      enforcementPoint: "extension-action-batch",
    })).toMatchObject({ allowed: false, requiresConfirmation: false });
  });

  test("candidate mismatches are audited while the legacy result remains authoritative", () => {
    const audit = vi.fn<(record: CapabilityPolicyMismatchAudit) => void>();
    const candidate: CapabilityPolicy = {
      decide: () => ({
        allowed: true,
        requiresConfirmation: false,
        reason: "PRIVATE_CANDIDATE_REASON",
      }),
    };
    const policy = createAuditedCapabilityPolicy(
      legacyCapabilityPolicy,
      candidate,
      audit,
    );
    const context = {
      actionType: "evaluate",
      mode: "standard",
      enforcementPoint: "privileged-effect",
      payload: { script: "PRIVATE_PAYLOAD_SENTINEL" },
    } as const;

    const decision = policy.decide(context);

    expect(decision).toMatchObject({ allowed: false });
    expect(audit).toHaveBeenCalledOnce();
    expect(audit.mock.calls[0][0]).toMatchObject({
      kind: "decision-mismatch",
      actionType: "evaluate",
      mode: "standard",
      enforcementPoint: "privileged-effect",
    });
    expect(JSON.stringify(audit.mock.calls[0][0])).not.toContain(
      "PRIVATE_PAYLOAD_SENTINEL",
    );
    expect(JSON.stringify(audit.mock.calls[0][0])).not.toContain(
      "PRIVATE_CANDIDATE_REASON",
    );
    expect(audit.mock.calls[0][0]).not.toHaveProperty("payload");
  });

  test("candidate and audit failures cannot change the legacy decision or leak raw errors", () => {
    const seen: CapabilityPolicyMismatchAudit[] = [];
    const policy = createAuditedCapabilityPolicy(
      legacyCapabilityPolicy,
      { decide: () => { throw new Error("PRIVATE_CANDIDATE_FAILURE"); } },
      (record) => {
        seen.push(record);
        throw new Error("audit transport failed");
      },
    );

    expect(policy.decide({
      actionType: "click",
      mode: "standard",
      enforcementPoint: "loop-action-queue",
    })).toEqual({ allowed: true, requiresConfirmation: false });
    expect(seen).toEqual([expect.objectContaining({
      kind: "candidate-error",
      candidate: null,
    })]);
    expect(JSON.stringify(seen)).not.toContain("PRIVATE_CANDIDATE_FAILURE");
  });

  test("the production current policy invokes both adapters and sanitizes an active mismatch", () => {
    const legacyDecision = {
      allowed: false,
      requiresConfirmation: false,
      reason: "legacy block",
    } as const;
    const legacy = vi.spyOn(legacyCapabilityPolicy, "decide")
      .mockReturnValue(legacyDecision);
    const candidate = vi.spyOn(candidateCapabilityPolicy, "decide")
      .mockReturnValue({
        allowed: true,
        requiresConfirmation: false,
        reason: "PRIVATE_CANDIDATE_REASON",
      });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const context = {
      actionType: "evaluate",
      mode: "standard",
      enforcementPoint: "privileged-effect",
      payload: { script: "PRIVATE_PAYLOAD_SENTINEL" },
    } as const;

    expect(currentCapabilityPolicy.decide(context)).toBe(legacyDecision);
    expect(legacy).toHaveBeenCalledOnce();
    expect(candidate).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    const emitted = JSON.stringify(warn.mock.calls[0]);
    expect(emitted).toContain("decision-mismatch");
    expect(emitted).not.toContain("PRIVATE_PAYLOAD_SENTINEL");
    expect(emitted).not.toContain("PRIVATE_CANDIDATE_REASON");
  });
});
