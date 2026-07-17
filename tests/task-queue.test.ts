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
import { installLocalStorageStub, restoreLocalStorageStub } from "./helpers";
import { setSecret, deleteSecret } from "../src/lib/agent/secrets";

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

  test("does NOT post to an RFC1918 private IP (skipped + warned)", async () => {
    stubChrome("http://192.168.1.1/hook", false);
    await fireNotifications("task", false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  test("does NOT post to a cloud-metadata IP (skipped + warned)", async () => {
    stubChrome("http://169.254.169.254/latest/meta-data", false);
    await fireNotifications("task", false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  test("does NOT post to a link-local IPv6 address (skipped + warned)", async () => {
    stubChrome("http://[fe80::1]/hook", false);
    await fireNotifications("task", false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  test("does NOT post to a NAT64-embedded cloud-metadata IPv6 address (skipped + warned)", async () => {
    stubChrome("http://[64:ff9b::a9fe:a9fe]/hook", false);
    await fireNotifications("task", false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  test("does NOT post to a CGNAT range IP (skipped + warned)", async () => {
    stubChrome("http://100.64.0.1/hook", false);
    await fireNotifications("task", false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  test("does NOT post to an unspecified 0.0.0.0 IP (skipped + warned)", async () => {
    stubChrome("http://0.0.0.0/hook", false);
    await fireNotifications("task", false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  test("still fires the notification independently of the webhook check", async () => {
    const chrome = stubChrome("javascript:alert(1)", true);
    await fireNotifications("task", true);
    expect(fetchMock).not.toHaveBeenCalled();
 // The notification path is exercised even though the webhook was rejected.
    expect(chrome.notifications.create).toHaveBeenCalled();
  });
});

describe("fireNotifications webhook task redaction", () => {
  beforeEach(() => {
    installLocalStorageStub();
  });

  afterEach(async () => {
 // Drop any seeded secret so it can't leak into other tests in this file.
 // `setSecret` persists via the secrets module, so remove it the same way.
    await deleteSecret("api_key").catch(() => {});
    localStorage.removeItem("open_cowork_secrets");
    restoreLocalStorageStub();
  });

  test("POSTs a webhook body whose task is redacted (never the raw secret)", async () => {
    const SECRET = "sk-webhook-secret-555";
    // Seed the secret via `setSecret` (NOT a raw `localStorage` write): the
 // secrets module now memoizes `listSecrets()` results, and earlier tests in
 // this file populate that cache with an empty set. Writing the secret through
 // `setSecret` invalidates the cache + bumps the secret-set version so the
 // subsequent `redactSecrets` call re-reads storage and actually masks the
 // value. A direct `localStorage.setItem` would be invisible to the cache and
 // the secret would leak. This is a guard-preserving test fix only — it does
 // not change production redaction behavior.
    await setSecret("api_key", SECRET);

    stubChrome("https://hooks.example.com/notify", false);
    await fireNotifications(`task contained ${SECRET} value`, true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = (fetchMock.mock.calls[0] as unknown[])[1] as { body?: string };
    expect(body).toBeDefined();
    const parsed = JSON.parse(body.body ?? "{}") as { task?: string };
    expect(parsed.task).toBeDefined();
    expect(parsed.task).toContain("[REDACTED:api_key]");
    expect(parsed.task).not.toContain(SECRET);
  });
});

describe("fireNotifications webhook abort timeout", () => {
  test("aborts a hung webhook POST after ~5s (no leaked connection)", async () => {
    stubChrome("http://localhost:8080/hook", false);
 // Track abort via a fake AbortController (abort may be an own-instance
 // method, so spying on the prototype is unreliable across runtimes).
    let abortCalls = 0;
    class FakeAbortController {
      signal = { aborted: false };
      abort(): void {
        abortCalls += 1;
        this.signal.aborted = true;
      }
    }
    const RealAbortController = (globalThis as Record<string, unknown>).AbortController;
    (globalThis as Record<string, unknown>).AbortController = FakeAbortController;
 // A fetch that never resolves nor rejects — without the 5s abort, the SW
 // would hold the connection open until the endpoint itself times out.
    const hungFetch = vi.fn(() => new Promise<Response>(() => {}));
    (globalThis as Record<string, unknown>).fetch = hungFetch;

    let threw = false;
    vi.useFakeTimers();
    try {
      const p = fireNotifications("task", true);
 // Let fireNotifications reach the point where it schedules the 5s abort
 // timer (this happens after the `await chrome.storage.local.get`
 // microtask resumes), then advance the fake clock past the timeout.
      await p;
      vi.advanceTimersByTime(5000 + 10);
    } catch {
      threw = true;
    } finally {
      vi.useRealTimers();
      (globalThis as Record<string, unknown>).AbortController = RealAbortController;
    }

    expect(threw).toBe(false);
    expect(hungFetch).toHaveBeenCalledTimes(1);
 // The 5s AbortController timeout must fire so a hung endpoint can't retain
 // a connection inside the MV3 service worker indefinitely.
    expect(abortCalls).toBe(1);
  });
});
