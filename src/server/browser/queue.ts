import { AppError, asAppError } from "../errors";

/** Finite admission bound for hostile/unbounded clients. */
export const MAX_QUEUED_OPERATIONS = 64;
/** Concurrent Chromium read lane; exclusive writers drain this first. */
const MAX_PARALLEL_READ_OPERATIONS = 8;

export type QueueMode = "exclusive" | "read";

export interface OperationQueueHost {
  shutdownSignal(): AbortSignal;
  recoverAfterAbort(operation: Promise<unknown>): Promise<void>;
  normalizeError(error: unknown, signal?: AbortSignal): unknown;
}

/**
 * One exclusive profile/action lane plus a bounded parallel-read lane.
 * A timed-out operation recovers the old browser lifecycle before the
 * next waiter is released, so a late close cannot steal another request's lock.
 */
export class BrowserOperationQueue {
  queuedOperations = 0;
  lastActivityAt = Date.now();
  sessionGeneration = 0;
  readonly activeOperationControllers = new Set<AbortController>();
  operationTail = Promise.resolve();
  activeReadOperations = 0;
  readonly readPermitWaiters: Array<() => void> = [];
  readDrainPromise = Promise.resolve();
  private readDrainRelease: (() => void) | undefined;

  constructor(private readonly host: OperationQueueHost) {}

  bumpSession(): void {
    this.sessionGeneration += 1;
  }

  abortAll(): void {
    for (const controller of this.activeOperationControllers) {
      controller.abort();
    }
  }

  async run<T>(
    signal: AbortSignal | undefined,
    operation: (operationSignal: AbortSignal) => Promise<T>,
    queueTimeoutMs: number,
    operationTimeoutMs?: number,
    mode: QueueMode = "exclusive",
    touchActivity = true,
    operationTimeoutDetails?: () => object,
  ): Promise<T> {
    if (this.queuedOperations >= MAX_QUEUED_OPERATIONS) {
      throw new AppError("BROWSER_QUEUE_FULL", "The browser action queue is full; wait for an active operation to finish and retry.", { retryable: true, details: { hint: "Wait for the active browser operation to finish, then retry." } });
    }
    this.queuedOperations += 1;
    const readMode = mode === "read";
    const requestSessionGeneration = this.sessionGeneration;
    const requestStartedAt = Date.now();
    const queueDeadline = requestStartedAt + Math.max(1, Math.floor(queueTimeoutMs));
    const previous = this.operationTail;
    const readDrain = this.readDrainPromise;
    let release!: () => void;
    if (!readMode) {
      this.operationTail = new Promise<void>((resolvePromise) => {
        release = resolvePromise;
      });
    }
    const queueSignal = combineSignals(signal, this.host.shutdownSignal());
    let acquired = false;
    let deferRelease = false;
    let operationPromise: Promise<T> | undefined;
    try {
      if (readMode) {
        while (true) {
          const readTurn = this.operationTail;
          await waitForTurn(readTurn, queueSignal, remainingQueueBudget(queueDeadline, queueTimeoutMs, queueSignal), queueTimeoutMs);
          ensureQueueBudget(queueDeadline, queueTimeoutMs, queueSignal);
          if (readTurn !== this.operationTail) {
            continue;
          }
          await this.acquireReadPermit(queueSignal, remainingQueueBudget(queueDeadline, queueTimeoutMs, queueSignal), queueTimeoutMs);
          try {
            ensureQueueBudget(queueDeadline, queueTimeoutMs, queueSignal);
          } catch (error) {
            this.endReadOperation();
            throw error;
          }
          if (readTurn !== this.operationTail) {
            this.endReadOperation();
            continue;
          }
          break;
        }
      } else {
        await waitForTurn(previous, queueSignal, remainingQueueBudget(queueDeadline, queueTimeoutMs, queueSignal), queueTimeoutMs);
        await waitForTurn(readDrain, queueSignal, remainingQueueBudget(queueDeadline, queueTimeoutMs, queueSignal), queueTimeoutMs);
        ensureQueueBudget(queueDeadline, queueTimeoutMs, queueSignal);
      }
      acquired = true;
      throwIfAborted(queueSignal);
      if (requestSessionGeneration !== this.sessionGeneration) {
        throw new AppError("SESSION_CLOSED", "The browser session was closed before this operation started.", { retryable: true });
      }
      const operationController = new AbortController();
      this.activeOperationControllers.add(operationController);
      const operationSignal = combineSignals(queueSignal, operationController.signal) ?? operationController.signal;
      let operationTimedOut = false;
      let abortRequested = false;
      let recoveryAfterAbort: Promise<void> | undefined;
      const operationBudgetMs = operationTimeoutMs === undefined
        ? undefined
        : Math.max(1, Math.floor(operationTimeoutMs) - Math.max(0, Date.now() - requestStartedAt));
      let removeAbortListener: (() => void) | undefined;
      let rejectAbort!: (error: unknown) => void;
      const abortPromise = new Promise<never>((_, reject) => {
        rejectAbort = reject;
        const onAbort = (): void => {
          if (abortRequested) {
            return;
          }
          abortRequested = true;
          const timedOut = operationTimedOut;
          operationController.abort();
          reject(timedOut
            ? new AppError("BROWSER_TIMEOUT", `The browser operation exceeded its ${Math.max(1, Math.floor(operationTimeoutMs ?? 0))}ms action deadline.`, { retryable: true, details: { phase: "action", timeoutMs: Math.max(1, Math.floor(operationTimeoutMs ?? 0)) } })
            : new AppError("CANCELLED", "The browser action was cancelled."));
        };
        if (queueSignal?.aborted) {
          onAbort();
          return;
        }
        queueSignal?.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = (): void => queueSignal?.removeEventListener("abort", onAbort);
      });
      const deadlineTimer = operationTimeoutMs === undefined ? undefined : setTimeout(() => {
        if (!queueSignal?.aborted) {
          operationTimedOut = true;
          if (!abortRequested) {
            abortRequested = true;
            operationController.abort();
            rejectAbort(new AppError("BROWSER_TIMEOUT", `The browser operation exceeded its ${Math.max(1, Math.floor(operationTimeoutMs ?? 0))}ms action deadline.`, { retryable: true, details: { phase: "action", timeoutMs: Math.max(1, Math.floor(operationTimeoutMs ?? 0)) } }));
          }
        }
      }, operationBudgetMs);
      if (touchActivity) {
        this.lastActivityAt = Date.now();
      }
      operationPromise = Promise.resolve().then(() => operation(operationSignal));
      void operationPromise.catch(() => undefined);
      if (abortRequested) {
        recoveryAfterAbort = this.host.recoverAfterAbort(operationPromise);
      }
      try {
        const result = await Promise.race([operationPromise, abortPromise]);
        throwIfAborted(operationSignal);
        return result;
      } catch (error) {
        const normalized = this.host.normalizeError(error, operationSignal);
        if (operationTimedOut && !queueSignal?.aborted) {
          const normalizedError = asAppError(normalized);
          throw new AppError("BROWSER_TIMEOUT", `The browser operation exceeded its ${Math.max(1, Math.floor(operationTimeoutMs ?? 0))}ms action deadline.`, {
            retryable: true,
            details: { ...normalizedError.details, ...operationTimeoutDetails?.(), phase: "action", timeoutMs: Math.max(1, Math.floor(operationTimeoutMs ?? 0)) },
            cause: error,
          });
        }
        throw normalized;
      } finally {
        if (deadlineTimer) {
          clearTimeout(deadlineTimer);
        }
        removeAbortListener?.();
        this.activeOperationControllers.delete(operationController);
        if (abortRequested && operationPromise) {
          deferRelease = true;
          recoveryAfterAbort ??= this.host.recoverAfterAbort(operationPromise);
          await recoveryAfterAbort;
          deferRelease = false;
        }
      }
    } finally {
      this.queuedOperations -= 1;
      if (readMode) {
        if (acquired) {
          this.endReadOperation();
        }
      } else if (acquired) {
        if (!deferRelease) {
          release();
        }
      } else {
        void Promise.all([previous, readDrain]).then(release, release);
      }
    }
  }

  private beginReadOperation(): void {
    if (this.activeReadOperations === 0) {
      this.readDrainPromise = new Promise<void>((resolvePromise) => {
        this.readDrainRelease = resolvePromise;
      });
    }
    this.activeReadOperations += 1;
  }

  private endReadOperation(): void {
    this.activeReadOperations = Math.max(0, this.activeReadOperations - 1);
    const next = this.readPermitWaiters.shift();
    if (next) {
      next();
    } else if (this.activeReadOperations === 0) {
      this.readDrainRelease?.();
      this.readDrainRelease = undefined;
    }
  }

  private async acquireReadPermit(signal: AbortSignal | undefined, timeoutMs: number, queueTimeoutMs: number): Promise<void> {
    if (this.activeReadOperations < MAX_PARALLEL_READ_OPERATIONS && this.readPermitWaiters.length === 0) {
      this.beginReadOperation();
      return;
    }
    await new Promise<void>((resolvePromise, reject) => {
      let settled = false;
      const waiter = (): void => finish(resolvePromise);
      const removeWaiter = (): void => {
        const index = this.readPermitWaiters.indexOf(waiter);
        if (index >= 0) {
          this.readPermitWaiters.splice(index, 1);
        }
      };
      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        removeWaiter();
        callback();
      };
      const onAbort = (): void => finish(() => reject(new AppError("CANCELLED", "The browser action was cancelled.")));
      const timer = setTimeout(() => finish(() => reject(queueTimeoutError(queueTimeoutMs))), Math.max(1, Math.floor(timeoutMs)));
      this.readPermitWaiters.push(waiter);
      if (signal?.aborted) {
        onAbort();
      } else {
        signal?.addEventListener("abort", onAbort, { once: true });
      }
    });
    this.beginReadOperation();
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AppError("CANCELLED", "The browser action was cancelled.");
  }
}

export function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (active.length === 0) {
    return undefined;
  }
  if (active.length === 1) {
    return active[0];
  }
  return AbortSignal.any(active);
}

function queueTimeoutError(timeoutMs: number): AppError {
  return new AppError("BROWSER_QUEUE_TIMEOUT", `The browser operation waited more than ${timeoutMs}ms in the browser action queue.`, { retryable: true, details: { phase: "queue", timeoutMs } });
}

function remainingQueueBudget(deadline: number, timeoutMs: number, signal?: AbortSignal): number {
  throwIfAborted(signal);
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw queueTimeoutError(timeoutMs);
  }
  return remaining;
}

function ensureQueueBudget(deadline: number, timeoutMs: number, signal?: AbortSignal): void {
  throwIfAborted(signal);
  if (deadline - Date.now() <= 0) {
    throw queueTimeoutError(timeoutMs);
  }
}

async function waitForTurn(previous: Promise<void>, signal: AbortSignal | undefined, timeoutMs: number, queueTimeoutMs: number): Promise<void> {
  if (signal?.aborted) {
    throw new AppError("CANCELLED", "The browser action was cancelled.");
  }
  await new Promise<void>((resolvePromise, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      reject(queueTimeoutError(queueTimeoutMs));
    }, Math.max(1, Math.floor(timeoutMs)));
    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => {
      settle(() => reject(new AppError("CANCELLED", "The browser action was cancelled.")));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    previous.then(() => {
      settle(resolvePromise);
    }, () => {
      settle(resolvePromise);
    });
  });
}
