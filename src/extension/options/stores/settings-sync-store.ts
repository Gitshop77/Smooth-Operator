/**
 * options/stores/settings-sync-store.ts — authoritative load/save status for
 * the Options settings surface (Phase 12).
 *
 * The heavy settings persistence stays in settings-sync.ts (it owns the DOM
 * read + storage write); this store makes the *acknowledgement* explicit and
 * deterministic: load and save each move through `pending → ok | failed` and a
 * failure carries a sanitized message so the UI can surface it instead of
 * silently losing a save.
 */

export type SettingsSyncPhase = "idle" | "pending" | "ok" | "failed";

export interface SettingsSyncState {
  loadState: SettingsSyncPhase;
  saveState: SettingsSyncPhase;
  /** Sanitized failure message of the current/last failed operation. */
  lastError?: string;
  savedAt?: number;
}

export type SettingsSyncAction =
  | { type: "SETTINGS_LOAD_START" }
  | { type: "SETTINGS_LOAD_OK" }
  | { type: "SETTINGS_LOAD_FAIL"; error: string }
  | { type: "SETTINGS_SAVE_START" }
  | { type: "SETTINGS_SAVE_OK" }
  | { type: "SETTINGS_SAVE_FAIL"; error: string };

export const initialSettingsSyncState: SettingsSyncState = {
  loadState: "idle",
  saveState: "idle",
};

export function settingsSyncReducer(
  state: SettingsSyncState,
  action: SettingsSyncAction,
): SettingsSyncState {
  switch (action.type) {
    case "SETTINGS_LOAD_START":
      return { ...state, loadState: "pending", lastError: undefined };
    case "SETTINGS_LOAD_OK":
      return { ...state, loadState: "ok", lastError: undefined };
    case "SETTINGS_LOAD_FAIL":
      return { ...state, loadState: "failed", lastError: action.error };
    case "SETTINGS_SAVE_START":
      return { ...state, saveState: "pending", lastError: undefined };
    case "SETTINGS_SAVE_OK":
      return { ...state, saveState: "ok", savedAt: Date.now(), lastError: undefined };
    case "SETTINGS_SAVE_FAIL":
      return { ...state, saveState: "failed", lastError: action.error };
  }
}
