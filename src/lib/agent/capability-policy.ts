/** Browser-independent action capability decision seam. */

import {
  checkActionAllowed,
  requiresConfirmation,
  type AgentMode,
} from "./modes";

export type CapabilityEnforcementPoint =
  | "loop-action-queue"
  | "loader-step"
  | "extension-action-batch"
  | "privileged-effect";

/** Deliberately excludes action payload fields such as URLs, text, and keys. */
export interface CapabilityPolicyContext {
  readonly actionType: string;
  readonly mode: AgentMode;
  readonly enforcementPoint: CapabilityEnforcementPoint;
}

export interface CapabilityPolicyDecision {
  readonly allowed: boolean;
  readonly requiresConfirmation: boolean;
  readonly reason?: string;
}

export interface CapabilityPolicy {
  decide(context: CapabilityPolicyContext): CapabilityPolicyDecision;
}

/** Construct an independently invoked adapter over the current mode table. */
function createModeTableCapabilityPolicy(): CapabilityPolicy {
  return {
    decide(context) {
      const allowed = checkActionAllowed(context.actionType, context.mode);
      if (!allowed.allowed) {
        return {
          allowed: false,
          requiresConfirmation: false,
          ...(allowed.reason ? { reason: allowed.reason } : {}),
        };
      }
      return {
        allowed: true,
        requiresConfirmation: requiresConfirmation(context.actionType, context.mode),
      };
    },
  };
}

/** Authoritative adapter preserving the current mode-table behavior exactly. */
export const legacyCapabilityPolicy = createModeTableCapabilityPolicy();

/**
 * Explicit Phase 5 shadow candidate. It intentionally starts at parity, but
 * remains a distinct adapter invocation so future policy work is audited
 * before it receives authority.
 */
export const candidateCapabilityPolicy = createModeTableCapabilityPolicy();

export interface CapabilityPolicyMismatchAudit {
  readonly kind: "decision-mismatch" | "candidate-error";
  readonly actionType: string;
  readonly mode: AgentMode;
  readonly enforcementPoint: CapabilityEnforcementPoint;
  readonly legacy: CapabilityPolicyAuditDecision;
  readonly candidate: CapabilityPolicyAuditDecision | null;
}

export type CapabilityPolicyAuditDecision = Pick<
  CapabilityPolicyDecision,
  "allowed" | "requiresConfirmation"
>;

export type CapabilityPolicyAuditSink = (
  record: CapabilityPolicyMismatchAudit,
) => void;

function decisionsMatch(
  left: CapabilityPolicyDecision,
  right: CapabilityPolicyDecision,
): boolean {
  return left.allowed === right.allowed &&
    left.requiresConfirmation === right.requiresConfirmation &&
    left.reason === right.reason;
}

function auditDecision(
  decision: CapabilityPolicyDecision,
): CapabilityPolicyAuditDecision {
  return {
    allowed: decision.allowed,
    requiresConfirmation: decision.requiresConfirmation,
  };
}

/**
 * Compare a candidate policy without granting it authority. The legacy result
 * is always returned. Candidate/audit failures are reduced to typed metadata;
 * neither raw errors nor action payload data can cross the audit boundary.
 */
export function createAuditedCapabilityPolicy(
  legacy: CapabilityPolicy,
  candidate: CapabilityPolicy,
  audit: CapabilityPolicyAuditSink,
): CapabilityPolicy {
  return {
    decide(context) {
      const legacyDecision = legacy.decide(context);
      let candidateDecision: CapabilityPolicyDecision | null = null;
      let kind: CapabilityPolicyMismatchAudit["kind"] | null = null;
      try {
        candidateDecision = candidate.decide(context);
        if (!decisionsMatch(legacyDecision, candidateDecision)) {
          kind = "decision-mismatch";
        }
      } catch {
        kind = "candidate-error";
      }
      if (kind) {
        try {
          audit({
            kind,
            actionType: context.actionType,
            mode: context.mode,
            enforcementPoint: context.enforcementPoint,
            legacy: auditDecision(legacyDecision),
            candidate: candidateDecision ? auditDecision(candidateDecision) : null,
          });
        } catch {
          // Diagnostics must never change an authorization decision.
        }
      }
      return legacyDecision;
    },
  };
}

/** Active payload-safe production mismatch sink. */
export function reportCapabilityPolicyMismatch(
  record: CapabilityPolicyMismatchAudit,
): void {
  console.warn("[capability-policy] shadow decision mismatch", record);
}

/** Current production policy: candidate is observed, legacy stays authoritative. */
export const currentCapabilityPolicy = createAuditedCapabilityPolicy(
  legacyCapabilityPolicy,
  candidateCapabilityPolicy,
  reportCapabilityPolicyMismatch,
);
