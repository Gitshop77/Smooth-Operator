import { describe, it, expect } from "vitest";
import { toneForStatus } from "@/components/cowork/shared/status-pill";

describe("toneForStatus", () => {
  it("maps success-family statuses", () => {
    for (const s of [
      "ok", "online", "connected", "active", "approved", "completed",
      "done", "enabled", "strong", "very-strong", "success",
    ]) {
      expect(toneForStatus(s)).toBe("success");
    }
  });

  it("maps warning-family statuses", () => {
    for (const s of [
      "idle", "loading", "pending", "thinking", "ready-to-resume",
    ]) {
      expect(toneForStatus(s)).toBe("warning");
    }
  });

  it("maps error-family statuses", () => {
    for (const s of [
      "error", "failed", "crashed", "blocked", "rejected", "weak",
      "critical", "offline", "disabled", "disabled-by-policy", "cancelled",
    ]) {
      expect(toneForStatus(s)).toBe("error");
    }
  });

  it("maps info-family statuses", () => {
    for (const s of ["info", "low", "log", "debug"]) {
      expect(toneForStatus(s)).toBe("info");
    }
  });

  it("is case-insensitive and returns neutral for unknown/empty", () => {
    expect(toneForStatus("ACTIVE")).toBe("success");
    expect(toneForStatus("")).toBe("neutral");
    expect(toneForStatus("bogus")).toBe("neutral");
  });
});
