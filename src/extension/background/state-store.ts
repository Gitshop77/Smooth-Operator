/**
 * background/state-store.ts — persisted run-state + keepalive alarm + domain config.
 *
 * Re-exports the run-state CRUD, safe-log, and system keep-awake helpers from
 * `./state-store-utils`.  Keeps the domain-config global and the chrome.alarms
 * keepalive alarm here because they are tightly coupled to the extension
 * lifecycle and do not benefit from extraction.
 */

export {
  safeLog,
  type RunState,
  type RunUsage,
  RUN_STATE_KEY,
  getRunState,
  saveRunState,
  saveRunStateForRun,
  initializeRunStateForRun,
  clearRunState,
  clearRunStateForRun,
  resetRunStateStoreForTests,
  zeroRunUsage,
  addCostEvent,
  requestKeepAwake,
  maybeReleaseKeepAwake,
} from "./state-store-utils";

import type { UrlPolicyConfig } from "@/lib/agent/security";
import { safeLog } from "./state-store-utils";

// ─── Keepalive alarm (MV3 SW lifecycle workaround) ──────────────────────────

export const KEEPALIVE_ALARM = "open_cowork_keepalive";
// 30s — Chrome's actual alarm floor since Chrome 120 (1 min before that; any
// sub-floor period is clamped with a console warning, so the intended 15s
// cadence never happens). Matches the ~30s SW idle window; `chrome.debugger`
// sessions already keep the SW alive while CDP is attached.
const KEEPALIVE_INTERVAL_MIN = 0.5;

/** Start a periodic alarm that touches the service worker to keep it alive. */
export async function startKeepalive(): Promise<void> {
  await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_INTERVAL_MIN });
}

/** Stop the keepalive alarm. */
export async function stopKeepalive(): Promise<void> {
  await chrome.alarms.clear(KEEPALIVE_ALARM);
}

// ─── Domain config (allow/blocklist) ────────────────────────────────────────

function setDomainConfigGlobal(c: UrlPolicyConfig): void {
  (globalThis as { __openCoworkDomainConfig?: UrlPolicyConfig }).__openCoworkDomainConfig = c;
}
function getDomainConfigGlobal(): UrlPolicyConfig | undefined {
  return (globalThis as { __openCoworkDomainConfig?: UrlPolicyConfig }).__openCoworkDomainConfig;
}

export async function loadAndSetDomainConfig(): Promise<UrlPolicyConfig> {
  try {
    const res = await chrome.storage.local.get(["allowedDomains", "blockedDomains"]);
    const rawAllowed = res.allowedDomains;
    const rawBlocked = res.blockedDomains;
    if (
      (rawAllowed !== undefined && !Array.isArray(rawAllowed)) ||
      (rawBlocked !== undefined && !Array.isArray(rawBlocked))
    ) {
      // A malformed policy shape (e.g. a string instead of `string[]`) must
      // fail CLOSED, not silently degrade to allow-all: the lib-side validator
      // rejects it as "no policy" on both the SW and content-script gates.
      // Flag enforcement + clear the cached config so `getDomainConfig`
      // blocks every navigation until the stored value is fixed.
      (globalThis as { __openCoworkDomainConfigEnforced?: boolean }).__openCoworkDomainConfigEnforced = true;
      delete (globalThis as { __openCoworkDomainConfig?: unknown }).__openCoworkDomainConfig;
      void safeLog(
        "error",
        "[Open Cowork] Domain config has an invalid shape (allowedDomains/blockedDomains must be string[]) — policy cleared, failing closed:",
      );
      return {};
    }
    const allowedDomains = (rawAllowed as string[] | undefined) || [];
    const blockedDomains = (rawBlocked as string[] | undefined) || [];
    const config: UrlPolicyConfig = {
      allowedDomains: allowedDomains.length > 0 ? allowedDomains : undefined,
      blockedDomains: blockedDomains.length > 0 ? blockedDomains : undefined,
    };
    setDomainConfigGlobal(config);
    return config;
  } catch (e) {
    (globalThis as { __openCoworkDomainConfigEnforced?: boolean }).__openCoworkDomainConfigEnforced = true;
    delete (globalThis as { __openCoworkDomainConfig?: unknown }).__openCoworkDomainConfig;
    void safeLog("error", "[Open Cowork] Failed to load domain config — cached policy cleared, failing closed:", e);
    throw e;
  }
}

/** Synchronous read of the domain config (set by {@link loadAndSetDomainConfig}). */
export function getDomainConfig(): UrlPolicyConfig {
  const cfg = getDomainConfigGlobal();
  const enforced =
    (globalThis as { __openCoworkDomainConfigEnforced?: boolean }).__openCoworkDomainConfigEnforced === true;
  if (enforced && cfg === undefined) {
    return { allowedDomains: ["__fail_closed__"] };
  }
  return cfg ?? {};
}
