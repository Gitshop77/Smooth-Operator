/**
 * completion webhook URL scheme validation.
 *
 * `fireNotifications` POSTs the task text to `webhookUrl`. The fix rejects
 * any URL that isn't an absolute `http:`/`https:` URL (so task text is
 * never exfiltrated to `javascript:`/`data:`/`file:`/arbitrary schemes).
 *
 * These tests stub the minimal `chrome` + `fetch` surface that
 * `fireNotifications` touches and assert which URLs actually get POSTed.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { fireNotifications } from "../src/extension/background/task-queue";

/** Minimal chrome stub covering only what fireNotifications reads. */
function stubChrome(webhookUrl: string | undefined, notify: boolean) {
  const chrome = {
    storage: {
      local: {
        get: vi.fn(async () => ({ webhookUrl, notifyOnCompletion: notify })),
      },
    },
    notifications: {
      create: vi.fn((_opts: unknown, _cb?: unknown) => {
        /* non-fatal */
      }),
    },
  };
  (globalThis as Record<string, unknown>).chrome = chrome;
  return chrome;
}

let fetchMock: ReturnType<typeof vi.fn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
  (globalThis as Record<string, unknown>).fetch = fetchMock;
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).chrome;
  delete (globalThis as Record<string, unknown>).fetch;
  warnSpy.mockRestore();
});

describe("fireNotifications webhook URL validation", () => {
  test("posts to a valid https webhook URL", async () => {
    stubChrome("https://hooks.example.com/notify", false);
    await fireNotifications("do the thing", true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(calledUrl).toBe("https://hooks.example.com/notify");
  });

  test("posts to a valid http webhook URL", async () => {
    stubChrome("http://localhost:8080/hook", false);
    await fireNotifications("task", false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe("http://localhost:8080/hook");
  });

  test("does NOT post to a javascript: URL (skipped + warned)", async () => {
    stubChrome("javascript:alert(document.cookie)", false);
    await fireNotifications("secret task", true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  test("does NOT post to a data: URL (skipped + warned)", async () => {
    stubChrome("data:text/plain,hi", false);
    await fireNotifications("task", false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  test("does NOT post to a malformed/relative URL (skipped + warned)", async () => {
    stubChrome("/relative/path", false);
    await fireNotifications("task", false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  test("does NOT post when no webhookUrl is configured", async () => {
    stubChrome(undefined, false);
    await fireNotifications("task", false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("still fires the notification independently of the webhook check", async () => {
    const chrome = stubChrome("javascript:alert(1)", true);
    await fireNotifications("task", true);
    expect(fetchMock).not.toHaveBeenCalled();
    // The notification path is exercised even though the webhook was rejected.
    expect(chrome.notifications.create).toHaveBeenCalled();
  });
});
