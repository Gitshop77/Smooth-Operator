/**
 * Regression test for the fail-CLOSED contract of `redactHistoryForPrompt`
 * (loop/messages.ts).
 *
 * If `redactSecrets` (the secret-value redactor) throws/rejects, the history
 * field must be masked with the `[REDACTED: redaction failed]` marker rather
 * than emitting the original secret-bearing text. This guards the
 * "secret values never cross the network" invariant against a future change
 * that would let a redaction exception fall through to the raw content.
 *
 * `redactSecrets` is mocked to reject ONLY for inputs containing the sentinel
 * `FORCE_FAIL`, so the browser-state fields (which are redacted with the same
 * function) still resolve and don't mask unrelated content.
 */

import { describe, test, expect, vi, beforeAll, afterAll } from "vitest";
import { buildNavigatorUserMessage } from "../src/lib/agent/loop/messages";
import { installLocalStorageStub, restoreLocalStorageStub } from "./helpers";
import type { HistoryItem } from "../src/lib/agent/types";

vi.mock("../src/lib/agent/secrets", () => ({
  redactSecrets: vi.fn((text: string) =>
    text.includes("FORCE_FAIL")
      ? Promise.reject(new Error("injected redaction failure"))
      : Promise.resolve(text),
  ),
  // `redactHistoryForPrompt` calls `syncSecretVersion()` (via the imported
  // `getSecretSetVersion`) on every run to invalidate its per-item redaction
  // cache when the secret set changes. The mock must expose this export so the
  // module import resolves; returning a constant version keeps the cache stable
  // for the duration of the test (no secret-set changes are exercised here).
  getSecretSetVersion: vi.fn(() => 1),
}));

beforeAll(() => {
  installLocalStorageStub();
});

afterAll(() => {
  restoreLocalStorageStub();
});

const baseBrowserState = {
  url: "https://example.com",
  title: "Login",
  tabs: [],
  elementsText: "",
  pageInfo: "scroll 0",
  newElementCount: 0,
};

function baseArgs(overrides: Partial<Parameters<typeof buildNavigatorUserMessage>[0]> = {}) {
  return {
    task: "do the thing",
    history: [],
    currentGoal: "fill the form",
    browserState: baseBrowserState,
    step: 0,
    maxSteps: 10,
    ...overrides,
  } as Parameters<typeof buildNavigatorUserMessage>[0];
}

describe("redactHistoryForPrompt fail-closed", () => {
  test("masks a history field when redaction throws instead of leaking it", async () => {
    const secretText = "FORCE_FAIL-super-secret-evaluation-text";
    const history: HistoryItem[] = [
      {
        step: 0,
        agent: "navigator",
        evaluation: secretText,
        memory: "memory note",
        goal: "goal text",
        results: [],
      },
    ];

    const msg = await buildNavigatorUserMessage(baseArgs({ history }));

    // The secret-bearing evaluation must not reach the prompt verbatim.
    expect(msg).not.toContain(secretText);
    // It must be masked by the fail-closed marker.
    expect(msg).toContain("[REDACTED: redaction failed]");
  });

  test("leaves clean history fields intact when redaction succeeds", async () => {
    const history: HistoryItem[] = [
      {
        step: 0,
        agent: "navigator",
        evaluation: "the page loaded successfully",
        memory: "memory note",
        goal: "goal text",
        results: [],
      },
    ];

    const msg = await buildNavigatorUserMessage(baseArgs({ history }));
    expect(msg).toContain("the page loaded successfully");
    expect(msg).not.toContain("[REDACTED: redaction failed]");
  });
});
