import { describe, it, expect } from "vitest";

import { assertTokenEnvironmentPairing } from "@/hooks/use-websocket";

describe("assertTokenEnvironmentPairing", () => {
  it("warns when the token is missing", () => {
    expect(assertTokenEnvironmentPairing(undefined, "production")).not.toBeNull();
  });

  it("warns when a dev token literal ships to production", () => {
    expect(assertTokenEnvironmentPairing("dev-token", "production")).not.toBeNull();
    expect(assertTokenEnvironmentPairing("changeme", "production")).not.toBeNull();
  });

  it("warns when a dev-shaped token ships to production", () => {
    expect(assertTokenEnvironmentPairing("abc-test-xyz", "production")).not.toBeNull();
    expect(assertTokenEnvironmentPairing("svc-local-1", "production")).not.toBeNull();
  });

  it("warns when a prod-looking token is used outside production", () => {
    expect(assertTokenEnvironmentPairing("a1b2c3-real-secret", "development")).not.toBeNull();
  });

  it("returns null for a clean prod token in production", () => {
    expect(assertTokenEnvironmentPairing("a1b2c3-real-secret", "production")).toBeNull();
  });
});
