/**
 * background/agent-bridge-utils.ts — Pure helpers, constants, and small state
 * modules extracted from agent-bridge.ts to keep the orchestrator file focused
 * on the run-lifecycle.
 */

import type { AgentMode } from "@/lib/agent/modes";

// ─── Constants ─────────────────────────────────────────────────────────────

export const DEFAULT_MAX_STEPS = 100;
export const DEFAULT_MODE: AgentMode = "standard";

// ─── Pure numeric helpers ──────────────────────────────────────────────────

/** Coerce an unknown stored/override value into a finite integer clamped to [min, max]. */
export function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return Math.min(max, Math.max(min, Math.floor(def)));
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Coerce an unknown stored/override value into a finite number >= min (unbounded above). */
export function clampNumber(v: unknown, def: number, min: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, n);
}

// ─── Synchronous RUN-guard flag ────────────────────────────────────────────

let runStarting = false;
let runStartCancellationRequested = false;

/** Read the synchronous RUN-guard flag (used by the RUN message handler). */
export function isRunStarting(): boolean {
  return runStarting;
}

/** Set the synchronous RUN-guard flag (used by the RUN message handler). */
export function setRunStarting(v: boolean): void {
  runStarting = v;
  // A cancellation request belongs to one admission attempt only. Retaining
  // it after that attempt has released the guard would incorrectly cancel a
  // later, independently admitted run.
  if (!v) runStartCancellationRequested = false;
}

/** Latch STOP during an admission gap before a RunController exists. */
export function requestRunStartCancellation(): void {
  if (runStarting) runStartCancellationRequested = true;
}

/** True when STOP won an in-progress admission before the controller existed. */
export function isRunStartCancellationRequested(): boolean {
  return runStartCancellationRequested;
}

// ─── Per-run download consent (full_agentic) ──────────────────────────────

let fullAgenticDownloadConsent = false;
let fullAgenticDownloadReserved = false;

/** Reset the per-run download-consent flag (called at the start of every run). */
export function resetDownloadConsent(): void {
  fullAgenticDownloadConsent = false;
  fullAgenticDownloadReserved = false;
}

/**
 * Reserve the one-time per-run download consent for the given run mode and
 * return whether a `saveAs` confirmation is required.
 */
export function consumeDownloadConsentForMode(mode: string | undefined): boolean {
  const requireSaveAs = mode === "full_agentic" && !fullAgenticDownloadConsent && !fullAgenticDownloadReserved;
  if (requireSaveAs) fullAgenticDownloadReserved = true;
  return requireSaveAs;
}

/**
 * Mark the per-run download consent as consumed. Call this only after a
 * download has actually succeeded.
 */
export function markDownloadConsentConsumed(): void {
  fullAgenticDownloadConsent = true;
  fullAgenticDownloadReserved = false;
}

/**
 * Release a previously reserved download consent (call after a download fails
 * or is cancelled) so a subsequent download re-prompts.
 */
export function releaseDownloadConsentReservation(): void {
  fullAgenticDownloadReserved = false;
}
