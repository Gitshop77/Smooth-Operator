/**
 * Background-owned policy for privileged runtime RPCs.
 *
 * A dispatch token only identifies a live run; it is not proof that a
 * confirmation-required action was approved.  The loop records an exact,
 * one-time grant after the user approves an action, and the authoritative RPC
 * boundary consumes that grant immediately before the browser effect.
 */

import type { AgentMode } from "@/lib/agent/modes";
import { currentCapabilityPolicy } from "@/lib/agent/capability-policy";
import type { AgentAction } from "@/lib/agent/types";
import type { RunDispatchToken } from "./run-controller";

const MAX_CONFIRMATION_GRANTS = 256;
/** Effect capabilities are request-scoped and single-use; a leaked capability
 *  must not remain replayable later in a long-lived service worker. */
const EFFECT_CAPABILITY_TTL_MS = 30_000;
const confirmationGrants = new Map<string, number>();
const effectCapabilities = new Map<string, { token: RunDispatchToken; action: string; expiresAt: number }>();

function newEffectCapability(): string | null {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (!globalThis.crypto?.getRandomValues) return null;
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stableValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`).join(",")}}`;
}

function grantKey(token: RunDispatchToken, action: Pick<AgentAction, "type">): string {
  return `${token.runId}:${token.dispatchRevision}:${stableValue(action)}`;
}

/** Record the user approval that was obtained by the authoritative loop. */
export function grantPrivilegedActionConfirmation(
  token: RunDispatchToken,
  action: AgentAction,
): void {
  const key = grantKey(token, action);
  confirmationGrants.set(key, (confirmationGrants.get(key) ?? 0) + 1);
  while (confirmationGrants.size > MAX_CONFIRMATION_GRANTS) {
    const oldest = confirmationGrants.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    confirmationGrants.delete(oldest);
  }
}

/**
 * Enforce capability policy and consume the exact approved-action grant when
 * confirmation is required.  A caller-controlled token or action payload can
 * never create a grant.
 */
export function authorizePrivilegedAction(
  token: RunDispatchToken,
  mode: AgentMode,
  action: AgentAction,
): { ok: true } | { ok: false; error: string } {
  const capability = currentCapabilityPolicy.decide({
    actionType: action.type,
    mode,
    enforcementPoint: "privileged-effect",
  });
  if (!capability.allowed) {
    return { ok: false, error: `BLOCKED: ${capability.reason ?? "action is not allowed"}` };
  }
  if (!capability.requiresConfirmation) return { ok: true };

  const key = grantKey(token, action);
  const remaining = confirmationGrants.get(key) ?? 0;
  if (remaining < 1) {
    return { ok: false, error: `BLOCKED: confirmation required for ${action.type}` };
  }
  if (remaining === 1) confirmationGrants.delete(key);
  else confirmationGrants.set(key, remaining - 1);
  return { ok: true };
}

/** Authorize one action at content's pre-effect boundary and mint its proof. */
export function authorizeAndIssueEffectCapability(
  token: RunDispatchToken,
  mode: AgentMode,
  action: AgentAction,
): { ok: true; effectCapability: string } | { ok: false; error: string } {
  const authorized = authorizePrivilegedAction(token, mode, action);
  if (!authorized.ok) return authorized;
  const effectCapability = newEffectCapability();
  if (!effectCapability) {
    return { ok: false, error: "BLOCKED: secure effect capability unavailable" };
  }
  effectCapabilities.set(effectCapability, {
    token,
    action: stableValue(action),
    expiresAt: Date.now() + EFFECT_CAPABILITY_TTL_MS,
  });
  while (effectCapabilities.size > MAX_CONFIRMATION_GRANTS) {
    const oldest = effectCapabilities.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    effectCapabilities.delete(oldest);
  }
  return { ok: true, effectCapability };
}

/** Consume the opaque background-issued proof before a delegated browser effect. */
export function consumeEffectCapability(
  effectCapability: unknown,
  token: RunDispatchToken,
  action: AgentAction,
): boolean {
  if (typeof effectCapability !== "string" || effectCapability.length < 8) return false;
  const record = effectCapabilities.get(effectCapability);
  if (!record || record.token.runId !== token.runId ||
      record.token.dispatchRevision !== token.dispatchRevision || record.action !== stableValue(action)) {
    return false;
  }
  if (Date.now() > record.expiresAt) {
    // Expired — a leaked capability must not stay replayable; delete and sweep
    // any other expired entries in the same bounded pass.
    effectCapabilities.delete(effectCapability);
    sweepExpiredEffectCapabilities();
    return false;
  }
  effectCapabilities.delete(effectCapability);
  return true;
}

/** Drop expired capabilities so the bounded registry cannot grow stale entries. */
function sweepExpiredEffectCapabilities(): void {
  const now = Date.now();
  for (const [key, record] of effectCapabilities) {
    if (now > record.expiresAt) effectCapabilities.delete(key);
  }
}

export function resetPrivilegedActionPolicyForTests(): void {
  confirmationGrants.clear();
  effectCapabilities.clear();
}
