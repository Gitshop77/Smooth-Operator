/**
 * Unit coverage for the LLM route's auth credential chain and SSE framing
 * (`src/lib/agent/llm/route/auth.ts`, `.../framing.ts`) plus the endpoint
 * fragment-preservation path. These utilities back every provider request but
 * were only exercised indirectly; the cases here pin the security-relevant
 * fall-through and snapshot behavior so a refactor can't silently regress them.
 */
import { describe, test, expect, afterEach } from "vitest";
import {
  optional,
  config,
  bearer,
  header,
  apiKeyAuth,
  resetInjectedEnv,
  MissingCredentialError,
} from "@/lib/agent/llm/route/auth";
import { sse } from "@/lib/agent/llm/route/framing";
import { Endpoint, buildURL } from "@/lib/agent/llm/route/endpoint";

const g = globalThis as unknown as { __openCoworkEnv?: Record<string, string> };

afterEach(() => {
  delete g.__openCoworkEnv;
  resetInjectedEnv();
  delete process.env.ROUTE_AUTH_TEST_KEY;
});

describe("auth credential chain", () => {
  test("optional(undefined).load throws MissingCredentialError", () => {
    expect(() => optional(undefined, "apiKey").load()).toThrow(MissingCredentialError);
  });

  test("optional('') is treated as missing and throws", () => {
    expect(() => optional("").load()).toThrow(MissingCredentialError);
  });

  test("orElse falls through an empty primary to the next source", () => {
    process.env.ROUTE_AUTH_TEST_KEY = "env-secret";
    const cred = optional(undefined, "apiKey").orElse(config("ROUTE_AUTH_TEST_KEY"));
    expect(cred.load()).toBe("env-secret");
  });

  test("orElse keeps a present primary over the fallback", () => {
    process.env.ROUTE_AUTH_TEST_KEY = "env-secret";
    const cred = optional("primary").orElse(config("ROUTE_AUTH_TEST_KEY"));
    expect(cred.load()).toBe("primary");
  });

  test("orElse throws when neither source resolves", () => {
    const cred = optional(undefined).orElse(config("ROUTE_AUTH_TEST_KEY"));
    expect(() => cred.load()).toThrow(MissingCredentialError);
  });

  test("bearer renders an Authorization header", () => {
    const headers = bearer("sk-123").apply({ method: "POST", url: "https://x", body: "", headers: {} });
    expect(headers.authorization).toBe("Bearer sk-123");
  });

  test("header renders a custom-named header", () => {
    const headers = header("x-api-key", "sk-123").apply({ method: "POST", url: "https://x", body: "", headers: {} });
    expect(headers["x-api-key"]).toBe("sk-123");
  });

  test("apiKeyAuth prefers an explicit auth strategy", () => {
    const explicit = bearer("explicit");
    const auth = apiKeyAuth({ auth: explicit }, "ROUTE_AUTH_TEST_KEY", "authorization");
    expect(auth).toBe(explicit);
  });

  test("apiKeyAuth resolves apiKey → env var → header render", () => {
    process.env.ROUTE_AUTH_TEST_KEY = "from-env";
    const auth = apiKeyAuth({}, "ROUTE_AUTH_TEST_KEY", "authorization");
    const headers = auth.apply({ method: "POST", url: "https://x", body: "", headers: {} });
    expect(headers.authorization).toBe("from-env");
  });
});

describe("auth injected-env snapshot", () => {
  test("config() reads the injected env when process.env lacks the key", () => {
    g.__openCoworkEnv = { INJECTED_KEY: "v1" };
    resetInjectedEnv();
    expect(config("INJECTED_KEY").load()).toBe("v1");
  });

  test("the snapshot is frozen: a later mutation is NOT observed until reset", () => {
    g.__openCoworkEnv = { INJECTED_KEY: "v1" };
    resetInjectedEnv();
    expect(config("INJECTED_KEY").load()).toBe("v1");
    g.__openCoworkEnv.INJECTED_KEY = "v2";
    expect(config("INJECTED_KEY").load()).toBe("v1");
    resetInjectedEnv();
    expect(config("INJECTED_KEY").load()).toBe("v2");
  });

  test("a null injected entry is treated as missing", () => {
    g.__openCoworkEnv = { INJECTED_KEY: null as unknown as string };
    resetInjectedEnv();
    expect(() => config("INJECTED_KEY").load()).toThrow(MissingCredentialError);
  });
});

describe("sse framing", () => {
  test("joins multi-line data fields with a newline", () => {
    expect(sse.parse("data: a\ndata: b\n\n")).toEqual(["a\nb"]);
  });

  test("ignores comment lines and stray blank lines", () => {
    expect(sse.parse(": keep-alive\n\n")).toEqual([]);
    expect(sse.parse("\n\n")).toEqual([]);
  });

  test("strips a single leading space after the colon", () => {
    expect(sse.parse("data: hello\n\n")).toEqual(["hello"]);
    expect(sse.parse("data:hello\n\n")).toEqual(["hello"]);
  });

  test("flushes a truncated tail with no trailing newline", () => {
    expect(sse.parse("data: hello")).toEqual(["hello"]);
  });

  test("tolerates CRLF line endings", () => {
    expect(sse.parse("data: hi\r\n\r\n")).toEqual(["hi"]);
  });

  test("a bare 'data' line with no colon contributes an empty value", () => {
    expect(sse.parse("data\ndata: x\n\n")).toEqual(["\nx"]);
  });
});

describe("endpoint fragment preservation", () => {
  test("relative path fragment survives the query merge", () => {
    const ep = Endpoint.path("/chat#frag", { query: { a: "1" } });
    expect(buildURL(ep, {})).toBe("/chat?a=1#frag");
  });

  test("relative path with existing query + fragment merges into one '?'", () => {
    const ep = Endpoint.path("/chat?x=1#frag", { query: { a: "1" } });
    const url = buildURL(ep, {});
    expect(url).toBe("/chat?x=1&a=1#frag");
  });
});
