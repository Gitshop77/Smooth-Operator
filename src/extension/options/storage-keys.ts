/**
 * options/storage-keys.ts — canonical chrome.storage.local key map.
 *
 * Extracted from settings-sync.ts so sibling modules that only need the key
 * constant don't pull in the entire settings-sync module and its import-time
 * side effects (chrome.storage.local.get callback, populateProviderSelect).
 */

export const STORAGE_KEYS = {
  provider: "provider",
  /** Provider API key — held in chrome.storage.SESSION. A local value is a
   * legacy migration source only; verified migration replaces it with an
   * opaque credentialManifest backed by extension-origin IndexedDB. */
  apiKey: "apiKey",
  /** Exact opt-in flag for persistence in the credential vault. */
  rememberApiKey: "rememberApiKey",
  /** Non-secret pointer to the extension-origin credential vault. */
  credentialManifest: "open_cowork_credential_manifest_v1",
  /** Non-secret, resumable legacy migration journal. */
  credentialMigration: "open_cowork_credential_migration_v1",
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
  /** Monotonic background-owned revision counter for the run-history list
   *  (guards concurrent whole-list mutations across contexts). */
  historyRevision: "open_cowork_run_history_revision",
  /** Storage-version marker map (settings/history/schedules), background-owned. */
  storageVersion: "open_cowork_storage_version",
  // The custom-tools key intentionally keeps its legacy spelling: the runtime
  // loader (registry-data.ts CUSTOM_TOOLS_STORAGE_KEY) reads this exact key
  // and is not aligned for a rename yet — changing it here would silently
  // orphan every user tool at runtime.
  customTools: "__opencowork_custom_tools",
  // Notification rule keys (added for the Notify tab redesign).
  notifyOnCompletion: "notifyOnCompletion",
  notifyOnError: "notifyOnError",
  notifyOnTakeover: "notifyOnTakeover",
  webhookUrl: "webhookUrl",
  // Quick-prompt CRUD (Prompts tab).
  quickPrompts: "open_cowork_quick_prompts",
  // Custom domain skills (Skills tab).
  customSkills: "open_cowork_custom_skills",
  // General settings (settings-sync.ts load/save paths).
  screenshotQuality: "screenshotQuality",
  enableScreenshots: "enableScreenshots",
  stealthEnabled: "stealthEnabled",
  enableLocalVision: "enableLocalVision",
  visionMode: "visionMode",
  allowedDomains: "allowedDomains",
  blockedDomains: "blockedDomains",
  agentMode: "agentMode",
  // Reasoning-effort config (O1): read by llm-direct.ts getReasoningEffort /
  // getReasoningBudget / getForceReasoning; written by settings-sync.ts
  // doSaveSettings (from the options UI). Key literals match the llm-direct
  // reads exactly — do not rename without updating both sides.
  reasoningEffort: "reasoningEffort",
  reasoningBudget: "reasoningBudget",
  forceReasoning: "forceReasoning",
  // Provider-config UI warning banner state (provider-config-ui.ts).
  providerResetWarning: "provider_reset_warning",
  // Provider-scoped config record (O8): chrome.storage.local["providerConfigs"]
  // keyed by provider id (model/baseUrl/resourceName/provenance per provider).
  // Read by provider-config.ts readProviderConfig (nested wins over the flat
  // top-level mirror); written only by settings-sync.ts doSaveSettings — the
  // record is never copied from an untrusted payload.
  providerConfigs: "providerConfigs",
} as const;
