import { afterEach, describe, expect, test, vi } from "vitest";

describe("background safeLog redaction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("masks unstored key shapes and bearer tokens before console output", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { safeLog } = await import("../src/extension/background/state-store-utils");

    await safeLog(
      "error",
      "provider failed",
      new Error("Bearer secretBearerToken123456 sk-live-abcdefghijklmnop"),
    );

    expect(error).toHaveBeenCalledTimes(1);
    const output = String(error.mock.calls[0][0]);
    expect(output).not.toContain("secretBearerToken123456");
    expect(output).not.toContain("abcdefghijklmnop");
    expect(output).toContain("[REDACTED]");
  });
});
