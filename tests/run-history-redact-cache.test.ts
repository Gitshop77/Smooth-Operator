/**
 * The run-history redaction cache (`redactValue` in run-history-utils)
 * must be keyed by the secret-set version. Caching by input string alone means
 * a version bump between runs never invalidates stale redactions:
 *
 * - run 1 with no secrets caches the value AS-IS; a secret added later must
 *   still redact on the next call (under-redaction leak to run history).
 * - run 1 with a secret registered caches the REDACTED form; deleting the
 *   secret must restore the raw value (over-redaction).
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { redactValue, redactRunSecrets } from "../src/lib/agent/run-history-utils";
import { RunBuilder } from "../src/lib/agent/run-history";
import { setSecret, deleteSecret } from "../src/lib/agent/secrets";
import { installLocalStorageStub, restoreLocalStorageStub } from "./helpers";
import type { LogEvent } from "../src/lib/agent/types";

beforeAll(() => {
  installLocalStorageStub();
});

afterAll(() => {
  restoreLocalStorageStub();
});

describe("redactValue cache invalidation on secret-set change", () => {
  test("a value cached with no secrets is re-redacted after a secret is added", async () => {
    const value = "cache-dir-a-sensitive-value-123";
    // Cached while the secret set is empty → value stored as-is.
    expect(await redactValue(value)).toBe(value);
    // Adding a secret bumps the set version; the cached unredacted form must
    // NOT be served.
    await setSecret("cache-secret-a", value);
    try {
      expect(await redactValue(value)).toBe("[REDACTED:cache-secret-a]");
    } finally {
      await deleteSecret("cache-secret-a");
    }
  });

  test("a value cached while a secret existed is re-evaluated after the secret is deleted", async () => {
    const value = "cache-dir-b-sensitive-value-456";
    // Cached while the secret is registered → redacted form stored.
    await setSecret("cache-secret-b", value);
    try {
      expect(await redactValue(value)).toBe("[REDACTED:cache-secret-b]");
    } finally {
      await deleteSecret("cache-secret-b");
    }
    // Deleting the secret bumps the version again; the stale redacted cache
    // entry must NOT be served — the raw value comes back.
    expect(await redactValue(value)).toBe(value);
  });
});

describe("redactRunSecrets applies key-shape redaction on every persisted surface", () => {
  test("task and result text mask well-known key shapes", async () => {
    const GSK = `gsk-${"a".repeat(24)}`;
    const GHP = `ghp_${"b".repeat(36)}`;
    const builder = new RunBuilder(`use ${GSK} for the api`);
    const run = builder.finish({ success: true, text: `saved ${GHP}` });
    const out = await redactRunSecrets(run);
    expect(out.task).not.toContain(GSK);
    expect(out.result!.text).not.toContain(GHP);
  });

  test("step event messages mask DB connection strings", async () => {
    const builder = new RunBuilder("task");
    builder.addEvent({
      type: "action-result",
      step: 1,
      name: "fill",
      success: true,
      message: "postgres://user:pass@db.example.com:5432/app",
    });
    const run = builder.finish({ success: true, text: "done" });
    const out = await redactRunSecrets(run);
    const msg = (out.steps[0] as LogEvent & { message: string }).message;
    expect(msg).not.toContain("pass@db.example.com");
  });
});
