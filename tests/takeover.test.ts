/**
 * Deterministic (no-LLM) coverage for the takeover RESUME trust guard.
 *
 * `isTrustedResumeSender` is the predicate that decides whether an inbound
 * `RESUME` message may un-pause the agent loop. It MUST reject any sender that
 * is not our own extension (id mismatch) or that arrives on a content-script
 * `tab` (a web page can never un-pause the loop). These tests lock that
 * invariant at the unit level so a refactor of the predicate can't silently
 * weaken the takeover trust boundary.
 */
import { describe, test, expect, afterEach } from "vitest";
import { isTrustedResumeSender } from "../src/lib/agent/loop/helpers/takeover";

function setChrome(id: string): void {
  (globalThis as { chrome?: unknown }).chrome = { runtime: { id } };
}

describe("isTrustedResumeSender", () => {
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  test("undefined / missing sender is rejected", () => {
    setChrome("ext-id");
    expect(isTrustedResumeSender(undefined)).toBe(false);
  });

  test("sender with a mismatched extension id is rejected", () => {
    setChrome("ext-id-0001");
    expect(
      isTrustedResumeSender({ id: "other-ext-9999" } as chrome.runtime.MessageSender),
    ).toBe(false);
  });

  test("sender carrying a tab (content script) is rejected even with a matching id", () => {
    setChrome("ext-id-0001");
    expect(
      isTrustedResumeSender({
        id: "ext-id-0001",
        tab: { id: 7, url: "https://evil.example" },
      } as unknown as chrome.runtime.MessageSender),
    ).toBe(false);
  });

  test("a trusted extension page sender (matching id, no tab) is accepted", () => {
    setChrome("ext-id-0001");
    expect(
      isTrustedResumeSender({ id: "ext-id-0001" } as chrome.runtime.MessageSender),
    ).toBe(true);
  });
});
