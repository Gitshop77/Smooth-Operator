/**
 * options/storage-keys.ts — canonical chrome.storage.local key map.
 *
 * Extracted from settings-sync.ts so sibling modules that only need the key
 * constant don't pull in the entire settings-sync module and its import-time
 * side effects (chrome.storage.local.get callback, populateProviderSelect).
 */

export const STORAGE_KEYS = {
  provider: "provider",
  /** Provider API key — held in chrome.storage.SESSION (memory-only, never
   * written to disk in plaintext unless the user opts into "remember on this
   * device", see api-key-storage.ts syncRememberedApiKey). Read by
   * provider-config.ts readStoredApiKey; legacy `local["apiKey"]` values are
   * migrated into session at Options load. */
  apiKey: "apiKey",
  /** Opt-in flag: persist the API key on disk (chrome.storage.local) and
   * re-hydrate it into session storage after browser restarts. OFF by
   * default — the key then lives only in memory. Read by
   * api-key-storage.ts ensureApiKeyInSession. */
  rememberApiKey: "rememberApiKey",
  model: "model",
  baseUrl: "baseUrl",
  resourceName: "resourceName",
  maxSteps: "maxSteps",
  maxActions: "maxActions",
  plannerInterval: "plannerInterval",
  maxFailures: "maxFailures",
  costCap: "costCap",
  defaultTask: "defaultTask",
  secrets: "open_cowork_secrets",
  scheduledTasks: "open_cowork_scheduled_tasks",
  runHistory: "open_cowork_run_history",
  customTools: "__opencowork_custom_tools",
 // Notification rule keys (added for the Notify tab redesign).
  notifyOnCompletion: "notifyOnCompletion",
  notifyOnError: "notifyOnError",
  notifyOnTakeover: "notifyOnTakeover",
  webhookUrl: "webhookUrl",
  // Quick-prompt CRUD (Prompts tab).
  quickPrompts: "open_cowork_quick_prompts",
} as const;
