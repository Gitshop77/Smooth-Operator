/**
 * Direct SSRF-guard tests for the OpenAI-compatible provider layer.
 *
 * `assertSafeUserBaseURL` is the guard invoked at BOTH `resolveProfile` and
 * `configure` for every user-supplied `baseURL`, including the narrow
 * ollama/litellm curated-local-origin exemption. `resolveProfile` (reached via
 * `toLLMProvider`) additionally throws `UnknownProviderError` for an unknown
 * provider with no baseURL. These tests pin that behavior so a refactor that
 * drops one of the two guard calls — or the fail-closed unknown-provider path —
 * is caught rather than failing open.
 */

import { describe, test, expect } from "vitest";
import {
  assertSafeUserBaseURL,
  UnsafeBaseUrlError,
} from "../src/lib/agent/llm/providers/openai-compatible-profile";
import { toLLMProvider } from "../src/lib/agent/llm/providers/openai-compatible";

describe("assertSafeUserBaseURL (openai-compatible SSRF guard)", () => {
  test("no baseURL override is a no-op (curated profile is used)", () => {
    expect(() => assertSafeUserBaseURL(undefined, "deepseek")).not.toThrow();
    expect(() => assertSafeUserBaseURL(undefined, "ollama")).not.toThrow();
  });

  test("loopback baseURL smuggled through a non-local provider id is rejected", () => {
    // The ollama/litellm exemption must NOT apply when the provider is a cloud
    // id like `deepseek` — an injected `http://localhost:11434` must not reach
    // the user's local model server.
    expect(() => assertSafeUserBaseURL("http://localhost:11434", "deepseek")).toThrow(
      UnsafeBaseUrlError,
    );
    expect(() => assertSafeUserBaseURL("http://127.0.0.1:11434/v1", "groq")).toThrow(
      UnsafeBaseUrlError,
    );
  });

  test("ollama with the exact curated loopback origin passes (user-configured exemption)", () => {
    // The curated loopback exemption only applies for a USER-configured
    // `baseURL` (allowLocalExemption === true). An untrusted/injected baseUrl is
    // never exempted, so the explicit `true` third argument is required.
    expect(() => assertSafeUserBaseURL("http://localhost:11434", "ollama", true)).not.toThrow();
    expect(() => assertSafeUserBaseURL("http://localhost:11434/v1", "ollama", true)).not.toThrow();
    expect(() => assertSafeUserBaseURL("http://127.0.0.1:11434", "ollama", true)).not.toThrow();
  });

  test("ollama exemption is scoped to the curated origin — a cloud-metadata sink still rejects", () => {
    // Even with provider='ollama', a non-curated origin falls through to the
    // strict policy, so the cloud-metadata / link-local address is rejected.
    expect(() => assertSafeUserBaseURL("http://169.254.169.254:11434/v1", "ollama")).toThrow(
      UnsafeBaseUrlError,
    );
    expect(() => assertSafeUserBaseURL("http://169.254.169.254/", "litellm")).toThrow(
      UnsafeBaseUrlError,
    );
  });
});

describe("toLLMProvider (openai-compatible) unknown provider", () => {
  test("unknown provider with no baseURL throws UnknownProviderError", () => {
    expect(() =>
      toLLMProvider({ provider: "definitely-not-real", model: "x" }),
    ).toThrow(/Unknown OpenAI-compatible provider/);
  });
});
