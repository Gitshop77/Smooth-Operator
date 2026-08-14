import { describe, expect, test } from "vitest";
import { computeVisionWarmHoldMs, VISION_WARM_HOLD_DEFAULT_MS } from "../src/extension/background/run-helpers-utils";
import { friendlyVisionInitError } from "../src/extension/vision-assistant/inference";

describe("computeVisionWarmHoldMs — idle-offload window", () => {
  test("defaults to the ~2-minute hold when no load time is known", () => {
    expect(computeVisionWarmHoldMs(null)).toBe(VISION_WARM_HOLD_DEFAULT_MS);
  });

  test("keeps the default 2-minute hold for a fast (cheap) load", () => {
    expect(computeVisionWarmHoldMs(0)).toBe(VISION_WARM_HOLD_DEFAULT_MS);
    expect(computeVisionWarmHoldMs(1000)).toBe(VISION_WARM_HOLD_DEFAULT_MS);
    // Exactly at the 4 s threshold is still the fast path.
    expect(computeVisionWarmHoldMs(4000)).toBe(VISION_WARM_HOLD_DEFAULT_MS);
  });

  test("extends to the 5-minute hold for an expensive reload (> 4s)", () => {
    // A slow (re)load pays a high offload/reload tax, so it stays warm longer.
    expect(computeVisionWarmHoldMs(4001)).toBe(300_000);
    expect(computeVisionWarmHoldMs(12_500)).toBe(300_000);
  });
});

describe("friendlyVisionInitError — actionable failure messages", () => {
  test("maps the fail-closed 'models are disabled' guard to a clear recovery hint", () => {
    const err = friendlyVisionInitError(new Error("Local and remote models are disabled"));
    expect(err.message).toMatch(/fail-closed/i);
    expect(err.message).toMatch(/clear the model cache/i);
    expect(err.message).toMatch(/450M-ONNX/i);
  });

  test("maps 404 / not-cached / revision misses to a re-download hint", () => {
    const err = friendlyVisionInitError(new Error("Client error (404): not found"));
    expect(err.message).toMatch(/could not load/i);
    expect(err.message).toMatch(/re-download/i);
  });

  test("passes unrelated errors through unchanged", () => {
    const err = friendlyVisionInitError(new Error("boom"));
    expect(err.message).toBe("boom");
  });

  test("wraps non-Error throws into an Error", () => {
    const err = friendlyVisionInitError("plain string failure");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("plain string failure");
  });
});