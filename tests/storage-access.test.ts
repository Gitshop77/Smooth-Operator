import { describe, expect, test, vi } from "vitest";
import { restrictSessionStorageToTrustedContexts } from "../src/extension/storage-access";

describe("extension storage access policy", () => {
  test("applies the strongest stable trusted-context session restriction", async () => {
    const setAccessLevel = vi.fn(async () => undefined);
    await restrictSessionStorageToTrustedContexts({ setAccessLevel });
    expect(setAccessLevel).toHaveBeenCalledOnce();
    expect(setAccessLevel).toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" });
  });

  test("fails closed when the browser cannot apply the restriction", async () => {
    await expect(restrictSessionStorageToTrustedContexts(
      {} as Pick<chrome.storage.StorageArea, "setAccessLevel">,
    )).rejects.toThrow(/restriction is unavailable/);

    const failure = new Error("policy rejected");
    await expect(restrictSessionStorageToTrustedContexts({
      setAccessLevel: vi.fn(async () => { throw failure; }),
    })).rejects.toBe(failure);
  });
});
