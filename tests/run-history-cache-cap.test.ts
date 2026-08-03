/**
 * The run-history redaction cache (`redactValue` in run-history-utils) is a
 * module-global Map keyed by input string. It must be size-capped so that
 * plaintext secret-adjacent values are not retained resident forever and the
 * map cannot grow without bound across a long session.
 *
 * redactSecrets is mocked to identity so cache hits are observable through
 * call counts: a cached string never re-enters redactSecrets.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import { redactValue } from "../src/lib/agent/run-history-utils";

const { redactSecretsSpy } = vi.hoisted(() => ({ redactSecretsSpy: vi.fn() }));

vi.mock("../src/lib/agent/secrets", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/lib/agent/secrets")>();
  return {
    ...mod,
    redactSecrets: redactSecretsSpy,
  };
});

beforeEach(() => {
  redactSecretsSpy.mockClear();
  redactSecretsSpy.mockImplementation(async (text: string) => text);
});

describe("redactCache size cap", () => {
  test("values beyond the cap evict the oldest entries (observed via redactSecrets re-entry)", async () => {
    // First value: cached on first call, served from cache on the second.
    await redactValue("v0");
    await redactValue("v0");
    expect(redactSecretsSpy).toHaveBeenCalledTimes(1);

    // Fill well past the cap (1000) without a secret-set version change.
    for (let i = 1; i <= 1100; i++) {
      await redactValue(`v${i}`);
    }
    expect(redactSecretsSpy).toHaveBeenCalledTimes(1101);

    // The oldest entry was evicted → re-enters redactSecrets.
    await redactValue("v0");
    expect(redactSecretsSpy).toHaveBeenCalledTimes(1102);

    // A recent entry is still cached.
    await redactValue("v1100");
    expect(redactSecretsSpy).toHaveBeenCalledTimes(1102);
  });
});
