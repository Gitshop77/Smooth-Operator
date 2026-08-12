import { beforeEach, describe, expect, test, vi } from "vitest";
import { decodeCredentialReference } from "../src/extension/credential-contract";

describe("Options platform client", () => {
  const reference = decodeCredentialReference({
    version: 1,
    handle: "cred_v1_abcdefabcdefabcdefabcdefabcdefab",
    providerId: "openai",
    revision: 4,
  })!;
  const sendMessage = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    sendMessage.mockReset();
    (globalThis as Record<string, unknown>).chrome = { runtime: { sendMessage } };
  });

  test("sends selected model and opaque reference without plaintext credential", async () => {
    sendMessage
      .mockResolvedValueOnce({ ok: true, kind: "credential_status", status: { status: "ready", reference } })
      .mockResolvedValueOnce({
        ok: true,
        kind: "connection_test",
        result: {
          version: 1,
          ok: true,
          code: "ok",
          latencyMs: 7,
          provider: "openai",
          model: "gpt-selected-client",
          message: "Connected.",
        },
      });
    const client = await import("../src/extension/options/options-platform-client");
    const status = await client.getProviderCredentialStatus();
    expect(status).toEqual({ status: "ready", reference });
    const result = await client.testSelectedProviderConnection({
      version: 1,
      provider: "openai",
      model: "gpt-selected-client",
      provenance: "user",
      credential: reference,
    });

    expect(result).toMatchObject({ ok: true, model: "gpt-selected-client" });
    const serialized = JSON.stringify(sendMessage.mock.calls);
    expect(serialized).toContain("gpt-selected-client");
    expect(serialized).toContain(reference.handle);
    expect(serialized).not.toMatch(/apiKey|sk-|plaintext/i);
  });
});
