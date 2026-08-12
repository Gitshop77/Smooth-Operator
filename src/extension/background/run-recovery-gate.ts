/**
 * A small startup barrier shared by RUN and STATUS.  The service worker has no
 * durable in-memory authority after a restart, so callers must not treat an
 * active persisted record as dispatch authority while recovery is deciding
 * whether it is an orphan.
 */
let recoveryAudit: Promise<void> = Promise.resolve();

export function setRunRecoveryAudit(audit: Promise<void>): void {
  // Keep the rejection observable to RUN/STATUS/STOP: if startup could not
  // prove that persisted authority was terminalized, a new run must not be
  // admitted. Attach a side observer only to prevent an unhandled-rejection
  // report before the first Chrome message awaits the original promise.
  recoveryAudit = audit;
  void audit.catch(() => {});
}

export function waitForRunRecoveryAudit(): Promise<void> {
  return recoveryAudit;
}
