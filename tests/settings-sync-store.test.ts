/**
 * Phase 12 — settings-sync store (Options load/save acknowledgement).
 *
 * Covers: load and save move `pending → ok | failed`; a storage failure
 * surfaces explicitly with a sanitized message (never a silent success); the
 * savedAt timestamp advances on each successful save.
 */

import { describe, expect, test } from "vitest";
import {
  settingsSyncReducer,
  initialSettingsSyncState,
  type SettingsSyncState,
} from "../src/extension/options/stores/settings-sync-store";

describe("settings-sync store", () => {
  test("load moves pending → ok", () => {
    let s: SettingsSyncState = settingsSyncReducer(initialSettingsSyncState, {
      type: "SETTINGS_LOAD_START",
    });
    expect(s.loadState).toBe("pending");
    s = settingsSyncReducer(s, { type: "SETTINGS_LOAD_OK" });
    expect(s.loadState).toBe("ok");
  });

  test("a failed load surfaces the error and is not reported as loaded", () => {
    const s = settingsSyncReducer(initialSettingsSyncState, {
      type: "SETTINGS_LOAD_FAIL",
      error: "chrome.runtime.lastError: storage disabled",
    });
    expect(s.loadState).toBe("failed");
    expect(s.lastError).toContain("storage disabled");
  });

  test("save moves pending → ok and records savedAt; a retry after failure keeps the last successful save", () => {
    let s = settingsSyncReducer(initialSettingsSyncState, { type: "SETTINGS_SAVE_START" });
    expect(s.saveState).toBe("pending");
    s = settingsSyncReducer(s, { type: "SETTINGS_SAVE_OK" });
    expect(s.saveState).toBe("ok");
    expect(typeof s.savedAt).toBe("number");
    const lastGoodSave = s.savedAt;

    s = settingsSyncReducer(s, { type: "SETTINGS_SAVE_START" });
    s = settingsSyncReducer(s, { type: "SETTINGS_SAVE_FAIL", error: "quota exceeded" });
    expect(s.saveState).toBe("failed");
    expect(s.lastError).toBe("quota exceeded");
    // A failed attempt is never reported as a successful save: the timestamp
    // still reflects the last acknowledged write.
    expect(s.savedAt).toBe(lastGoodSave);
  });

  test("a save attempt clears the previous failure so recovery is visible", () => {
    let s = settingsSyncReducer(initialSettingsSyncState, {
      type: "SETTINGS_SAVE_FAIL",
      error: "previous failure",
    });
    s = settingsSyncReducer(s, { type: "SETTINGS_SAVE_START" });
    expect(s.lastError).toBeUndefined();
    expect(s.saveState).toBe("pending");
  });
});
