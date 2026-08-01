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
  RUN_STATE_KEY,
  getRunState,
  saveRunState,
  clearRunState,
  hardResetAbortRequested,
  requestKeepAwake,
  maybeReleaseKeepAwake,
} from "./state-store-utils";

import type { UrlPolicyConfig } from "@/lib/agent/security";
import { safeLog } from "./state-store-utils";

// ─── Keepalive alarm (MV3 SW lifecycle workaround) ──────────────────────────

export const KEEPALIVE_ALARM = "open_cowork_keepalive";
const KEEPALIVE_INTERVAL_MIN = 0.25; // 15s — the minimum MV3 alarm period

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
    const allowedDomains = (res.allowedDomains as string[] | undefined) || [];
    const blockedDomains = (res.blockedDomains as string[] | undefined) || [];
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
