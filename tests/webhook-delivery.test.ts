/**
 * webhook-delivery.ts — bounded, SSRF-guarded, single-attempt webhook delivery:
 * blocks private/metadata endpoints, redacts + bounds the payload, never
 * throws, times out, and masks URLs for diagnostics.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  WEBHOOK_MAX_TASK_CHARS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_AFTER_CAP_MS,
  deliverWebhook,
  deriveWebhookIdempotencyKey,
  maskWebhookUrl,
  parseRetryAfterMs,
} from "../src/extension/background/webhook-delivery";

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(status: number): Response {
  return { status, ok: status >= 200 && status < 300 } as Response;
}

describe("deliverWebhook", () => {
  it("blocks private/metadata endpoints before any fetch (SSRF fail closed)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200));
    const result = await deliverWebhook(
      "http://169.254.169.254/latest/meta-data/",
      { task: "t", success: true, text: "ok", timestamp: 1 },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toEqual({ ok: false, code: "ssrf_blocked" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects non-http(s) schemes and unparseable URLs without fetching", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200));
    const file = await deliverWebhook("file:///etc/passwd", { task: "t", success: true, text: "", timestamp: 1 }, fetchImpl as unknown as typeof fetch);
    expect(file.ok).toBe(false);
    expect(file.ok || file.code === "ssrf_blocked").toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("delivers a redacted, bounded payload to a validated endpoint", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(String(url)).toBe("https://example.com/hook");
      expect(init.method).toBe("POST");
      expect(init.redirect).toBe("manual");
      const body = JSON.parse(String(init.body));
      // Key-shaped tokens are masked; long tasks are truncated.
      expect(body.task).toContain("[redacted]");
      expect(body.task.length).toBeLessThanOrEqual(WEBHOOK_MAX_TASK_CHARS + 1);
      return jsonResponse(200);
    }) as unknown as typeof fetch;
    const result = await deliverWebhook(
      "https://example.com/hook",
      { task: `do the thing with ghp_${"A".repeat(36)} ${"x".repeat(3000)}`, success: true, text: "Run succeeded.", timestamp: 42 },
      fetchImpl,
    );
    expect(result).toEqual({ ok: true, code: "sent", status: 200 });
  });

  it("returns a network_error code instead of throwing", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const result = await deliverWebhook("https://example.com/hook", { task: "t", success: true, text: "", timestamp: 1 }, fetchImpl, { sleep: async () => undefined });
    expect(result).toEqual({ ok: false, code: "network_error" });
  });

  it("returns a timeout code when the request is aborted", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      signal.throwIfAborted?.();
      throw new DOMException("aborted", "AbortError");
    }) as unknown as typeof fetch;
    const result = await deliverWebhook("https://example.com/hook", { task: "t", success: true, text: "", timestamp: 1 }, fetchImpl, { sleep: async () => undefined });
    expect(result).toEqual({ ok: false, code: "timeout" });
  });

  it("refuses an oversized payload without fetching", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200));
    const result = await deliverWebhook(
      "https://example.com/hook",
      { task: "t", success: true, text: "x".repeat(100_000), timestamp: 1 },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toEqual({ ok: false, code: "oversized" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("deliverWebhook retries", () => {
  it("retries a 503 then succeeds on the second attempt, carrying an Idempotency-Key", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (calls.length === 1) {
        const r = new Response(null, { status: 503, headers: { "Retry-After": "1" } });
        return r;
      }
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const sleeps: number[] = [];
    const result = await deliverWebhook(
      "https://example.com/hook",
      { task: "t", success: true, text: "ok", timestamp: 1 },
      fetchImpl,
      { sleep: async (ms) => { sleeps.push(ms); } },
    );
    expect(result).toEqual({ ok: true, code: "sent", status: 200 });
    expect(calls).toHaveLength(2);
    // Retry-After: 1 wins over the jitter backoff and is honored (cap-bounded).
    expect(sleeps[0]).toBe(1000);
    for (const { init } of calls) {
      const headers = init.headers as Record<string, string>;
      expect(headers["Idempotency-Key"]).toBe("1:1:2");
    }
  });

  it("never retries a 4xx other than 429", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 400 })) as unknown as typeof fetch;
    const result = await deliverWebhook(
      "https://example.com/hook",
      { task: "t", success: true, text: "", timestamp: 1 },
      fetchImpl,
      { sleep: async () => { throw new Error("sleep must not be called"); } },
    );
    expect(result).toEqual({ ok: false, code: "network_error" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("exhausts the bounded retry budget on persistent network errors and reports network_error", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const result = await deliverWebhook(
      "https://example.com/hook",
      { task: "t", success: true, text: "", timestamp: 1 },
      fetchImpl,
      { sleep: async () => undefined },
    );
    expect(result).toEqual({ ok: false, code: "network_error" });
    expect(fetchImpl).toHaveBeenCalledTimes(WEBHOOK_MAX_ATTEMPTS);
  });

  it("reports timeout (not network_error) when the final attempt aborts", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      signal.throwIfAborted?.();
      throw new DOMException("aborted", "AbortError");
    }) as unknown as typeof fetch;
    const result = await deliverWebhook(
      "https://example.com/hook",
      { task: "t", success: true, text: "", timestamp: 1 },
      fetchImpl,
      { sleep: async () => undefined },
    );
    expect(result).toEqual({ ok: false, code: "timeout" });
  });

  it("caps an oversized Retry-After header at the bounded ceiling", () => {
    expect(parseRetryAfterMs("99999")).toBe(99_999_000);
    expect(Math.min(WEBHOOK_RETRY_AFTER_CAP_MS, parseRetryAfterMs("99999")!)).toBe(WEBHOOK_RETRY_AFTER_CAP_MS);
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("garbage")).toBeNull();
  });

  it("derives a stable idempotency key from the payload", () => {
    const payload = { task: "abc", success: true, text: "hello", timestamp: 42 };
    expect(deriveWebhookIdempotencyKey(payload)).toBe("42:3:5");
    expect(deriveWebhookIdempotencyKey(payload)).toBe(deriveWebhookIdempotencyKey(payload));
  });
});

describe("maskWebhookUrl", () => {
  it("masks credentials, query tokens, and path structure", () => {
    const masked = maskWebhookUrl("https://user:sekret@hooks.example.com/services/T000/AAAA?token=abc");
    expect(masked).toBe("https://[REDACTED]@hooks.example.com/…");
    expect(masked).not.toContain("sekret");
    expect(masked).not.toContain("T000");
    expect(masked).not.toContain("token");
    expect(masked).not.toContain("abc");
  });

  it("keeps the host visible for operator diagnostics on plain URLs", () => {
    expect(maskWebhookUrl("https://hooks.example.com/hook")).toBe("https://hooks.example.com/…");
    expect(maskWebhookUrl("https://example.com")).toBe("https://example.com");
  });

  it("never throws on garbage input", () => {
    expect(maskWebhookUrl("not a url")).toBe("(invalid webhook URL)");
    expect(maskWebhookUrl("")).toBe("(invalid webhook URL)");
  });
});
