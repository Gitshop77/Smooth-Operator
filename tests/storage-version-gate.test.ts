import { describe, expect, it, beforeEach } from "vitest";
import {
  captureStorageVersionFailure,
  getStorageVersionFailure,
  resetStorageVersionFailureForTests,
} from "../src/extension/background/storage-version-gate";
import { StorageVersionError } from "../src/lib/agent/storage-version";

describe("storage-version-gate", () => {
  beforeEach(() => resetStorageVersionFailureForTests());

  it("starts clear and stays clear for non-StorageVersionError failures", () => {
    expect(getStorageVersionFailure()).toBeNull();
    captureStorageVersionFailure(new Error("unrelated"));
    expect(getStorageVersionFailure()).toBeNull();
  });

  it("projects a StorageVersionError into a serializable STATUS shape", () => {
    captureStorageVersionFailure(new StorageVersionError("history", 3, 1));
    expect(getStorageVersionFailure()).toEqual({
      code: "STORAGE_VERSION_UNSUPPORTED",
      domain: "history",
      found: 3,
      supported: 1,
      message: expect.stringContaining('"history" is version 3'),
    });
  });

  it("keeps the first failure once captured", () => {
    captureStorageVersionFailure(new StorageVersionError("schedules", 2, 1));
    captureStorageVersionFailure(new StorageVersionError("settings", 9, 1));
    expect(getStorageVersionFailure()?.domain).toBe("schedules");
  });
});
