import { StorageVersionError } from "@/lib/agent/storage-version";

/**
 * A serializable projection of the most recent storage-version gate failure.
 * The SW must stay responsive after a fail-closed storage-version rejection so
 * STATUS can tell the panel (and the user) what is wrong; this module holds
 * that failure for the STATUS handler to report.
 */
export interface StorageVersionFailure {
  code: string;
  domain: string;
  found: number;
  supported: number;
  message: string;
}

let failure: StorageVersionFailure | null = null;

/** Record a storage-version gate rejection (idempotent, keeps the first). */
export function captureStorageVersionFailure(error: unknown): void {
  if (failure !== null || !(error instanceof StorageVersionError)) return;
  failure = {
    code: error.code,
    domain: error.domain,
    found: error.found,
    supported: error.supported,
    message: error.message,
  };
}

/** The captured storage-version failure, or null when the gate passed. */
export function getStorageVersionFailure(): StorageVersionFailure | null {
  return failure;
}

/** Test-only reset of the captured failure (module-level state). */
export function resetStorageVersionFailureForTests(): void {
  failure = null;
}
