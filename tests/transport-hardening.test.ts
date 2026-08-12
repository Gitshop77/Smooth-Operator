/**
 * Transport hardening + shared log sanitizer:
 *  - fetchWithTimeout sends `credentials: "omit"`, `cache: "no-store"`,
 *    `referrer: ""` so a configured/redirected endpoint can never receive
 *    ambient cookies/HTTP-auth, a cached prior body, or a Referer;
 *  - sanitizeForLog strips CR/LF/tab + C0 control chars from page-derived
 *    text before it enters any console/event message (CWE-117).
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchWithTimeout } from "../src/lib/agent/llm/route/transport-http-utils";
import { sanitizeForLog } from "../src/lib/agent/llm/route/url-redact";

describe("fetchWithTimeout — credential/cache/referrer hardening", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("the outgoing RequestInit includes credentials: omit, cache: no-store, referrer: ''", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    // A public IP literal passes the string-level SSRF gate without DNS.
    await fetchWithTimeout("https://93.184.216.34/v1/chat", { method: "POST", body: "{}" }, undefined, "untrusted");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://93.184.216.34/v1/chat");
    expect(init).toMatchObject({
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      referrer: "",
      method: "POST",
    });
  });
});

describe("sanitizeForLog — control-char neutralization", () => {
  test("strips CR/LF/tab so a page cannot forge log lines", () => {
    expect(sanitizeForLog("page said:\nforge me\rinjected\ttext")).toBe("page said: forge me injected text");
    expect(sanitizeForLog("normal text")).toBe("normal text");
  });

  test("strips C0 control characters (CWE-117)", () => {
    expect(sanitizeForLog("a\u0000b\u0007c\u001Bd")).toBe("a b c d");
    expect(sanitizeForLog("")).toBe("");
  });
});
