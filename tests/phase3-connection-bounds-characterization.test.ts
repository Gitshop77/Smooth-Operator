/**
 * Phase 3 characterization of Options Test Connection body handling.
 *
 * The provider transport has bounded stream utilities, but the Options helper
 * is a separate fetch implementation. These expected failures specify its own
 * limits before Phase 4 changes that seam.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { getJson } from "../src/extension/options/connection-test-utils";

const CONNECTION_BODY_CAP = 1024 * 1024;
const ERROR_PREVIEW_CAP = 1024;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function oversizedJson(): string {
  return JSON.stringify({ data: ["x".repeat(CONNECTION_BODY_CAP + 1)] });
}

async function settleWithin<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), 500);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("Phase 3 Options Test Connection body bounds", () => {
  test("rejects a success response whose declared length exceeds the Options body cap before parsing", async () => {
    const declaredBytes = CONNECTION_BODY_CAP + 1;
    const response = new Response('{"data":[]}', {
      status: 200,
      headers: { "content-length": String(declaredBytes), "content-type": "application/json" },
    });
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetchMock);

    expect(declaredBytes).toBeGreaterThan(CONNECTION_BODY_CAP);
    await expect(getJson("https://api.openai.com/v1/models", {})).rejects.toThrow(/body|response.*too large/i);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("rejects an actually oversized success stream instead of buffering it for JSON.parse", async () => {
    const bytes = oversizedJson();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(bytes));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    expect(new TextEncoder().encode(bytes).byteLength).toBeGreaterThan(CONNECTION_BODY_CAP);
    await expect(getJson("https://api.openai.com/v1/models", {})).rejects.toThrow(/body|response.*too large/i);
  });

  test("rejects an error response whose declared length exceeds the bounded preview budget", async () => {
    const declaredBytes = CONNECTION_BODY_CAP + 1;
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"message":"fixture error"}', {
      status: 429,
      headers: { "content-length": String(declaredBytes), "content-type": "application/json" },
    })));

    expect(declaredBytes).toBeGreaterThan(CONNECTION_BODY_CAP);
    await expect(getJson("https://api.openai.com/v1/models", {})).rejects.toThrow(/body|response.*too large/i);
  });

  test("rejects an oversized error stream after a bounded preview", async () => {
    const bytes = JSON.stringify({ message: "e".repeat(CONNECTION_BODY_CAP + 1) });
    const response = new Response(bytes, {
      status: 500,
      headers: { "content-type": "application/json" },
    });
    const json = vi.spyOn(response, "json");
    vi.stubGlobal("fetch", vi.fn(async () => response));

    expect(new TextEncoder().encode(bytes).byteLength).toBeGreaterThan(CONNECTION_BODY_CAP);
    const error = await getJson("https://api.openai.com/v1/models", {}).catch((reason: unknown) => reason as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/HTTP 500:.*body|response.*too large/i);
    expect((error as Error).message.length).toBeLessThanOrEqual(ERROR_PREVIEW_CAP + 32);
    // `Response.json()` necessarily buffers the entire 1 MiB+ error body.
    // A bounded preview reader must not call it at all.
    expect(json).not.toHaveBeenCalled();
  });

  test("a stalled success body propagates the Test Connection deadline instead of becoming an empty success", async () => {
    const deadline = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let bodyRead = false;
    let fetchSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      fetchSignal = init?.signal ?? undefined;
      return {
        ok: true,
        type: "basic",
        json: () => new Promise<never>((_, reject) => {
          bodyRead = true;
          deadline.signal.addEventListener("abort", () => reject(deadline.signal.reason), { once: true });
        }),
      } as unknown as Response;
    }));

    const pending = getJson("https://api.openai.com/v1/models", {});
    await vi.waitFor(() => expect(bodyRead).toBe(true));
    expect(fetchSignal).toBe(deadline.signal);
    deadline.abort(new DOMException("fixture body deadline", "TimeoutError"));
    await expect(pending).rejects.toThrow(/deadline|timeout|abort/i);
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
  });

  test("an oversized declared body is rejected even when body cancellation never settles", async () => {
    const cancel = vi.fn(() => new Promise<never>(() => {}));
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      type: "basic",
      headers: new Headers({ "content-length": String(CONNECTION_BODY_CAP + 1) }),
      body: { cancel },
    }) as unknown as Response));

    await expect(settleWithin(
      getJson("https://api.openai.com/v1/models", {}),
      "stalled body.cancel blocked rejection",
    )).rejects.toThrow(/body|response.*too large/i);
    expect(cancel).toHaveBeenCalledOnce();
  });

  test("an oversized streamed body is rejected even when reader cancellation never settles", async () => {
    const cancel = vi.fn(() => new Promise<never>(() => {}));
    const releaseLock = vi.fn();
    const read = vi.fn(async () => ({
      done: false,
      value: new Uint8Array(CONNECTION_BODY_CAP + 1),
    }));
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      type: "basic",
      headers: new Headers(),
      body: { getReader: () => ({ read, cancel, releaseLock }) },
    }) as unknown as Response));

    await expect(settleWithin(
      getJson("https://api.openai.com/v1/models", {}),
      "stalled reader.cancel blocked rejection",
    )).rejects.toThrow(/body|response.*too large/i);
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  test("a bodyless text fallback with a trusted bounded length still parses", async () => {
    const payload = JSON.stringify({ data: [{ id: "fixture-model" }] });
    const text = vi.fn(async () => payload);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      type: "basic",
      headers: new Headers({
        "content-length": String(new TextEncoder().encode(payload).byteLength),
      }),
      body: null,
      text,
    }) as unknown as Response));

    await expect(getJson("https://api.openai.com/v1/models", {})).resolves.toEqual({
      data: [{ id: "fixture-model" }],
    });
    expect(text).toHaveBeenCalledOnce();
  });

  test.each([undefined, "not-a-size"])(
    "a bodyless text fallback rejects an %s declared length before buffering",
    async (contentLength) => {
      const text = vi.fn(async () => oversizedJson());
      const headers = new Headers();
      if (contentLength !== undefined) headers.set("content-length", contentLength);
      vi.stubGlobal("fetch", vi.fn(async () => ({
        ok: true,
        type: "basic",
        headers,
        body: null,
        text,
      }) as unknown as Response));

      await expect(getJson("https://api.openai.com/v1/models", {})).rejects.toThrow(/bounded read/i);
      expect(text).not.toHaveBeenCalled();
    },
  );
});
