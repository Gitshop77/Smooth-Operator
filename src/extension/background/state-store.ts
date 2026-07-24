/**
 * background/state-store.ts — persisted run-state + keepalive alarm + domain config.
 *
 * Owns the `RunState` shape (persisted to `chrome.storage.session` for MV3
 * resilience), the keepalive alarm (which periodically touches the service
 * worker to keep it alive past the ~30s idle deadline), and the synchronous
 * `__openCoworkDomainConfig` global that the executor reads during action
 * execution.
 */

import type { AgentMode } from "@/lib/agent/modes";
import type { UrlPolicyConfig } from "@/lib/agent/security";
// `extension/background` depends on `lib/agent` (correct layering: the lib
// never imports `extension/background/*`), so a static import here is safe.
import { listScheduledTasks } from "@/lib/agent/scheduled-tasks";
import { redactSecrets } from "@/lib/agent/secrets";

/**
 * Log helper that redacts any embedded secrets before writing to the console.
 * Error objects (and the messages around them) can carry untrusted URLs, host
 * strings, or storage values, so the error is stringified and run through
 * `redactSecrets`. The call is fire-and-forget: if redaction itself fails we
 * suppress the line with a generic, opaque message rather than emitting the
 * raw (untrusted, possibly secret-bearing) log, so no secret can reach the
 * console via the fallback path.
 */
export async function safeLog(
  level: "error" | "warn",
  msg: string,
  err?: unknown,
): Promise<void> {
  const raw = err == null ? msg : `${msg} ${err instanceof Error && err.stack ? err.stack : String(err)}`;
  try {
    const redacted = await redactSecrets(raw);
    console[level](redacted);
  } catch {
    // Redaction itself failed — never emit the raw (untrusted, possibly
    // secret-bearing) message/error. Suppress with a generic, opaque line so
    // no secret can reach the console via this fallback path.
    console[level]("[redacted log suppressed]");
  }
}

// ─── Run state (persisted to chrome.storage.session for MV3 resilience) ─────

export interface RunState {
  task: string;
  maxSteps: number;
  mode: AgentMode;
  startTabId: number;
  currentTabId: number;
  step: number;
  active: boolean;
  abortRequested: boolean;
}

export const RUN_STATE_KEY = "open_cowork_run_state";

/**
 * In-memory cache of the last-read `RunState`. `getRunState` is called several
 * times per navigator step (extract/execute/navigate callbacks each read it),
 * so we serve the cached value to avoid redundant `chrome.storage.session`
 * round-trips on the hot path. The cache is invalidated on every external
 * `RUN_STATE_KEY` change (via `chrome.storage.onChanged`), and internal writers
 * (`saveRunState`/`clearRunState`) clear or refresh it, so it never diverges
 * from the persisted value. Session storage is sub-ms, so this is purely a
 * redundancy reduction — correctness is unchanged.
 */
let cachedRunState: RunState | null | undefined;

if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, _area) => {
    if (RUN_STATE_KEY in changes) cachedRunState = undefined;
  });
}

/** Merge a partial patch into the persisted run state.
 *
 * `abortRequested` is monotonic (once true it stays true) and must survive a
 * concurrent STOP arriving between `getRunState` and `set`. The previous guard
 * only re-stamped the flag when *this* read already saw `abortRequested ===
 * true`, so a STOP write racing a step-update write could still be clobbered.
 * We now OR-in the previously stored value unconditionally, which guarantees a
 * concurrent STOP is never lost regardless of read interleaving, and keeps the
 * `abortRequested` key present even when the incoming patch doesn't mention it. */
/** Serializes `saveRunState` writes so their read-modify-write steps don't interleave. */
let writeChain: Promise<unknown> = Promise.resolve();

/** Serialize a storage mutation through the shared `writeChain` so its
 * read-modify-write steps never interleave with another write. */
function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task);
  // Keep the chain alive even if a write rejects, so later writes aren't blocked.
  writeChain = run.catch(() => {});
  return run;
}

export async function saveRunState(state: Partial<RunState>): Promise<void> {
  return enqueueWrite(async () => {
    // Invalidate cache at execution time (not enqueue time) so concurrent reads
    // during the queue-wait see the last-known cached value rather than falling
    // through to potentially stale storage.
    cachedRunState = undefined;
    const cur = (await getRunState()) ?? {};
    const next = { ...cur, ...state } as RunState;
 // Write-safe abort merge: never trust only an equality check on this read.
 // OR-ing the stored + incoming values makes the STOP flag durable against a
 // concurrent step-update (or any other) partial write.
    next.abortRequested = Boolean((cur as RunState).abortRequested) || Boolean(state.abortRequested);
    cachedRunState = next;
    await chrome.storage.session.set({ [RUN_STATE_KEY]: next });
  });
}

/** Read the persisted run state, or null if no active run. */
export async function getRunState(): Promise<RunState | null> {
  if (cachedRunState !== undefined) return cachedRunState;
  const res = await chrome.storage.session.get(RUN_STATE_KEY);
  const raw = res[RUN_STATE_KEY];
  const state = (raw && typeof raw === "object" && "active" in raw && "task" in raw) ? raw as RunState : null;
  cachedRunState = state;
  return state;
}

/** Remove the persisted run state (called at the end of every run). */
export async function clearRunState(): Promise<void> {
  return enqueueWrite(async () => {
    cachedRunState = undefined;
    await chrome.storage.session.remove(RUN_STATE_KEY);
  });
}

/**
 * Hard-reset the persisted `abortRequested` flag to `false`. Unlike
 * `saveRunState` (which OR-s the existing value in so a `true` can never be
 * silently lost), this unconditionally clears it. Used at run START so a stale
 * `abortRequested: true` left behind by a previous run whose `clearRunState`
 * failed (storage error) cannot block the next run from starting.
 * A genuine STOP that arrives DURING this run's init re-sets the flag via
 * `saveRunState` and is caught by the post-init re-check in `startRun`, so this
 * reset cannot mask a real stop.
 */
export async function hardResetAbortRequested(): Promise<void> {
  await enqueueWrite(async () => {
    try {
      const res = await chrome.storage.session.get(RUN_STATE_KEY);
      const cur = res[RUN_STATE_KEY] as RunState | undefined;
      if (cur) {
        cur.abortRequested = false;
        cachedRunState = cur;
        await chrome.storage.session.set({ [RUN_STATE_KEY]: cur });
      }
    } catch (e) {
      console.error("[state-store] hardResetAbortRequested failed:", e);
      /* storage unavailable — non-fatal; the run's own abort checks cover it */
    }
  });
}

// ─── Keepalive alarm (MV3 SW lifecycle workaround) ──────────────────────────

export const KEEPALIVE_ALARM = "open_cowork_keepalive";
export const KEEPALIVE_INTERVAL_MIN = 0.25; // 15s — the minimum MV3 alarm period

/** Start a periodic alarm that touches the service worker to keep it alive. */
export async function startKeepalive(): Promise<void> {
  await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_INTERVAL_MIN });
}

/** Stop the keepalive alarm. */
export async function stopKeepalive(): Promise<void> {
  await chrome.alarms.clear(KEEPALIVE_ALARM);
}

// ─── Domain config (allow/blocklist) ────────────────────────────────────────

/**
 * Load the domain allow/blocklist from chrome.storage.local and
 * set it on `globalThis.__openCoworkDomainConfig` so the executor's
 * `getDomainConfig()` can read it synchronously during action execution.
 * Returns the loaded config so the caller can also use it directly.
 */
// Centralized typed bridge to the `globalThis.__openCoworkDomainConfig` value.
// Reading a global property can never throw, so the single unsafe cast lives
// only here (not repeated at every read/write site).
function setDomainConfigGlobal(c: UrlPolicyConfig): void {
  (globalThis as { __openCoworkDomainConfig?: UrlPolicyConfig }).__openCoworkDomainConfig = c;
}
function getDomainConfigGlobal(): UrlPolicyConfig | undefined {
  return (globalThis as { __openCoworkDomainConfig?: UrlPolicyConfig }).__openCoworkDomainConfig;
}

export async function loadAndSetDomainConfig(): Promise<UrlPolicyConfig> {
  try {
    const res = await chrome.storage.local.get(["allowedDomains", "blockedDomains"]);
    const allowedDomains = (res.allowedDomains as string[] | undefined) || [];
    const blockedDomains = (res.blockedDomains as string[] | undefined) || [];
    const config: UrlPolicyConfig = {
      allowedDomains: allowedDomains.length > 0 ? allowedDomains : undefined,
      blockedDomains: blockedDomains.length > 0 ? blockedDomains : undefined,
    };
    setDomainConfigGlobal(config);
    return config;
  } catch (e) {
 // On storage failure, fail CLOSED: cache a distinct "deny" posture rather
 // than an empty `{}` (which is indistinguishable from "no policy → allow
 // all" in `checkUrlAllowedWithDomainConfig`). We mark the policy as enforced
 // and clear the cached config so any navigation is BLOCKED until a valid
 // policy is reloaded, instead of silently degrading to allow-all. We
 // re-throw so the caller (startRun) can decide how to handle the failure —
 // it currently aborts the run rather than proceeding with an empty policy.
    (globalThis as { __openCoworkDomainConfigEnforced?: boolean }).__openCoworkDomainConfigEnforced = true;
    delete (globalThis as { __openCoworkDomainConfig?: unknown }).__openCoworkDomainConfig;
    void safeLog("error", "[Open Cowork] Failed to load domain config — cached policy cleared, failing closed:", e);
    throw e;
  }
}

/** Synchronous read of the domain config (set by {@link loadAndSetDomainConfig}). */
export function getDomainConfig(): UrlPolicyConfig {
  const cfg = getDomainConfigGlobal();
  // Fail-closed: when a policy is EXPECTED (enforced) but its config payload is
  // absent/unavailable (e.g. storage read failed and {@link loadAndSetDomainConfig}
  // cleared it), never return an empty `{}` — `checkUrlAllowed` would treat that
  // as allow-all and silently degrade the posture. Return a deny-all sentinel
  // instead, so any consumer that uses this value blocks navigation until a
  // valid policy is (re)loaded. When no policy is configured (not enforced) the
  // historical allow-all default is preserved.
  const enforced =
    (globalThis as { __openCoworkDomainConfigEnforced?: boolean }).__openCoworkDomainConfigEnforced === true;
  if (enforced && cfg === undefined) {
    return { allowedDomains: ["__fail_closed__"] };
  }
  return cfg ?? {};
}

// ─── System keep-awake (chrome.power) ────────────────────────────────────────
//
// Scheduled tasks only fire while Chrome is running. If the laptop
// sleeps (or the display turns off + OS suspends), `chrome.alarms.onAlarm`
// never fires — the scheduled task is silently skipped. To bridge this gap,
// `requestKeepAwake()` calls `chrome.power.requestKeepAwake("system")` whenever
// at least one enabled scheduled task exists, and `maybeReleaseKeepAwake()`
// releases the lock only when no enabled scheduled tasks remain.
//
// This cannot wake a CLOSED laptop — Chrome itself must be running for the
// service worker to receive the alarm. The "system" level prevents the OS
// from sleeping while Chrome is open; "display" would also keep the screen
// lit (overly aggressive for unattended runs).

/**
 * R9-A: Request the OS to keep the system awake IF at least one enabled
 * scheduled task is currently armed. Idempotent — repeated calls don't stack
 * (Chrome coalesces multiple `requestKeepAwake` calls into a single lock).
 * Safe to call outside the extension context (`chrome.power` missing → silent
 * no-op).
 *
 * The scheduled-tasks check is what makes this safe to call from contexts
 * where the caller doesn't know whether tasks are armed (e.g. service-worker
 * startup). Callers that JUST armed an alarm will redundantly re-confirm the
 * check — that's harmless.
 *
 * `listScheduledTasks` is a static import from `@/lib/agent/scheduled-tasks`
 * (see top-of-file). The layering is `extension/background` → `lib/agent`,
 * which is the correct direction; there is no circular dependency to avoid.
 */
export async function requestKeepAwake(): Promise<void> {
  try {
    const tasks = await listScheduledTasks();
    if (!tasks.some((t) => t.enabled)) return; // no pending scheduled tasks
    chrome.power.requestKeepAwake("system");
  } catch {
    /* `chrome.power` unavailable (no `power` permission) or non-extension
 * context — non-fatal, scheduled-task reliability degrades gracefully. */
  }
}

/**
 * R9-B: Release the system keep-awake lock IF AND ONLY IF no enabled
 * scheduled tasks remain armed. Used by `agent-bridge.ts`'s `finally` block
 * after a run completes — covers both "user clicked Stop after a manual run"
 * (no scheduled tasks → release) and "scheduled run finished naturally"
 * (other tasks still armed → keep the lock so the system doesn't sleep
 * through the next alarm).
 *
 * Without this conditional check, an unconditional release in the `finally`
 * block would drop the lock after every scheduled-task run, defeating the
 * purpose of `requestKeepAwake("system")` — the system could sleep between
 * fires and miss subsequent alarms entirely (alarms only fire while Chrome is
 * running, and Chrome can't run if the OS is asleep).
 *
 * `listScheduledTasks` is a static import from `@/lib/agent/scheduled-tasks`
 * (see top-of-file). The layering is `extension/background` → `lib/agent`,
 * which is the correct direction; there is no circular dependency to avoid.
 */
export async function maybeReleaseKeepAwake(): Promise<void> {
  try {
    const tasks = await listScheduledTasks();
    if (tasks.some((t) => t.enabled)) return; // other scheduled tasks still pending
    chrome.power.releaseKeepAwake();
  } catch {
    /* `chrome.power` unavailable or storage read failed — non-fatal. */
  }
}
