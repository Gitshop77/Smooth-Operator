import { afterEach, describe, expect, test, vi } from "vitest";
import { createProviderConnectionService } from "../src/extension/background/provider-connection-service";
import type { ProviderConnectionConfigV1 } from "../src/extension/options-platform-contract";
import { decodeCredentialReference } from "../src/extension/credential-contract";

const credential = decodeCredentialReference({
  version: 1,
  handle: "cred_v1_0123456789abcdef0123456789abcdef",
  providerId: "openai",
  revision: 3,
})!;

const config: ProviderConnectionConfigV1 = {
  version: 1,
  provider: "openai",
  model: "gpt-selected-wire-model",
  provenance: "user",
  credential,
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ProviderConnectionService", () => {
  test("runs a bounded minimal generation through the selected runtime model and discards content", async () => {
    const chat = vi.fn(async () => ({ content: "sensitive generated diagnostic body" }));
    const buildProvider = vi.fn(async () => ({ chat }));
    const resolveCredential = vi.fn(async () => ({ ok: true as const, value: "sk-secret-wire" }));
    let now = 1_000;
    const service = createProviderConnectionService(resolveCredential, {
      buildProvider: buildProvider as never,
      now: () => (now += 12),
    });

    const result = await service.test(config);

    expect(resolveCredential).toHaveBeenCalledWith(config.credential);
    expect(buildProvider).toHaveBeenCalledWith(expect.objectContaining({
      provider: "openai",
      model: "gpt-selected-wire-model",
      apiKey: "sk-secret-wire",
      provenance: "user",
    }));
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      messages: [{ role: "user", content: "Reply with OK." }],
      maxTokens: 8,
      signal: expect.any(AbortSignal),
    }));
    expect(result).toEqual({
      version: 1,
      ok: true,
      code: "ok",
      latencyMs: 12,
      provider: "openai",
      model: "gpt-selected-wire-model",
      message: "Connected to openai with gpt-selected-wire-model.",
    });
    expect(JSON.stringify(result)).not.toContain("sensitive generated");
    expect(JSON.stringify(result)).not.toContain("sk-secret-wire");
  });

  test("rejects stale or provider-mismatched handles before provider construction", async () => {
    const resolveCredential = vi.fn(async () => ({ ok: false as const, reason: "stale" as const }));
    const buildProvider = vi.fn();
    const service = createProviderConnectionService(resolveCredential, { buildProvider: buildProvider as never });

    await expect(service.test(config)).resolves.toMatchObject({ ok: false, code: "credential_stale" });
    await expect(service.test({
      ...config,
      credential: { ...config.credential!, handle: "invalid-handle" as never },
    })).resolves.toMatchObject({ ok: false, code: "credential_stale" });
    expect(buildProvider).not.toHaveBeenCalled();
  });

  test("enforces one 15 second deadline across provider construction and generation", async () => {
    vi.useFakeTimers();
    const chat = vi.fn(({ signal }: { signal?: AbortSignal }) => new Promise((_, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const service = createProviderConnectionService(
      vi.fn(async () => ({ ok: true as const, value: "sk-timeout" })),
      {
        buildProvider: vi.fn(() => new Promise((resolve) => {
          setTimeout(() => resolve({ chat }), 10_000);
        })) as never,
      },
    );

    const pending = service.test(config);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chat).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_999);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toMatchObject({ ok: false, code: "timeout" });
  });

  test("times out a non-cooperative provider build and ignores its late resolution", async () => {
    vi.useFakeTimers();
    const build = deferred<{ chat: ReturnType<typeof vi.fn> }>();
    const chat = vi.fn(async () => ({ content: "must never be observed" }));
    const service = createProviderConnectionService(
      vi.fn(async () => ({ ok: true as const, value: "sk-build-timeout" })),
      { buildProvider: vi.fn(() => build.promise) as never },
    );

    const pending = service.test(config);
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(pending).resolves.toMatchObject({ ok: false, code: "timeout" });
    build.resolve({ chat });
    await Promise.resolve();
    expect(chat).not.toHaveBeenCalled();
  });

  test("suppresses a non-cooperative provider build's late rejection", async () => {
    vi.useFakeTimers();
    const build = deferred<never>();
    const service = createProviderConnectionService(
      vi.fn(async () => ({ ok: true as const, value: "sk-late-build-reject" })),
      { buildProvider: vi.fn(() => build.promise) as never },
    );

    const pending = service.test(config);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).resolves.toMatchObject({ ok: false, code: "timeout" });

    build.reject(new Error("late build secret sk-late-build-reject"));
    await Promise.resolve();
  });

  test("times out non-cooperative chat and discards late content or rejection", async () => {
    vi.useFakeTimers();
    const chatStage = deferred<{ content: string }>();
    const chat = vi.fn(() => chatStage.promise);
    const service = createProviderConnectionService(
      vi.fn(async () => ({ ok: true as const, value: "sk-late-chat" })),
      { buildProvider: vi.fn(async () => ({ chat })) as never },
    );

    const pending = service.test(config);
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await pending;
    expect(result).toMatchObject({ ok: false, code: "timeout" });

    chatStage.resolve({ content: "late sensitive generated content" });
    await Promise.resolve();
    expect(JSON.stringify(result)).not.toContain("late sensitive");

    const rejectingChat = deferred<never>();
    const secondService = createProviderConnectionService(
      vi.fn(async () => ({ ok: true as const, value: "sk-late-chat-reject" })),
      { buildProvider: vi.fn(async () => ({ chat: vi.fn(() => rejectingChat.promise) })) as never },
    );
    const secondPending = secondService.test(config);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(secondPending).resolves.toMatchObject({ ok: false, code: "timeout" });
    rejectingChat.reject(new Error("late chat secret sk-late-chat-reject"));
    await Promise.resolve();
  });

  test("caller abort remains prompt and distinct from the deadline", async () => {
    vi.useFakeTimers();
    const build = deferred<never>();
    const caller = new AbortController();
    const removeListener = vi.spyOn(caller.signal, "removeEventListener");
    const service = createProviderConnectionService(
      vi.fn(async () => ({ ok: true as const, value: "sk-user-abort" })),
      { buildProvider: vi.fn(() => build.promise) as never },
    );

    const pending = service.test(config, caller.signal);
    await Promise.resolve();
    caller.abort(new DOMException("User stopped", "AbortError"));

    await expect(pending).resolves.toMatchObject({
      ok: false,
      code: "cancelled",
      message: "Connection test cancelled",
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  test("keeps runtime SSRF policy authoritative and redacts credential-bearing errors", async () => {
    const service = createProviderConnectionService(
      vi.fn(async () => ({ ok: true as const, value: "sk-policy-secret" })),
      {
        buildProvider: vi.fn(async () => {
          throw new Error("SSRF blocked redirect with Authorization sk-policy-secret");
        }) as never,
      },
    );

    const result = await service.test({
      ...config,
      baseUrl: "https://attacker.example/v1",
      provenance: "injected",
    });

    expect(result).toMatchObject({ ok: false, code: "policy_blocked" });
    expect(result.message).toContain("[REDACTED]");
    expect(result.message).not.toContain("sk-policy-secret");
  });

  test("fails closed on a missing selected model", async () => {
    const buildProvider = vi.fn();
    const service = createProviderConnectionService(vi.fn(), { buildProvider: buildProvider as never });
    await expect(service.test({ ...config, model: "" })).resolves.toMatchObject({
      ok: false,
      code: "invalid_config",
    });
    expect(buildProvider).not.toHaveBeenCalled();
  });
});
