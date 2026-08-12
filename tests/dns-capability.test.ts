import { afterEach, describe, expect, test, vi } from "vitest";
import {
  dnsResolve,
  dnsResolverCapability,
} from "../src/lib/agent/llm/route/ssrf-dns";

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome;
});

describe("packaged DNS capability truthfulness", () => {
  test("does not use a Dev-channel namespace without the declared permission", async () => {
    const resolve = vi.fn((_host: string, callback: (result: { addresses: string[] }) => void) => {
      callback({ addresses: ["203.0.113.10"] });
    });
    (globalThis as { chrome?: unknown }).chrome = {
      dns: { resolve },
      runtime: { getManifest: () => ({ permissions: ["storage"] }) },
    };

    expect(dnsResolverCapability()).toBe("permission-missing");
    await expect(dnsResolve("provider.example")).resolves.toEqual({ kind: "unavailable" });
    expect(resolve).not.toHaveBeenCalled();
  });

  test("admits the resolver only when both API and permission are present", async () => {
    const resolve = vi.fn((_host: string, callback: (result: { addresses: string[] }) => void) => {
      callback({ addresses: ["203.0.113.10"] });
    });
    (globalThis as { chrome?: unknown }).chrome = {
      dns: { resolve },
      runtime: {
        lastError: undefined,
        getManifest: () => ({ permissions: ["storage", "dns"] }),
      },
    };

    expect(dnsResolverCapability()).toBe("available");
    await expect(dnsResolve("provider.example")).resolves.toEqual({
      kind: "resolved",
      ips: ["203.0.113.10"],
    });
    expect(resolve).toHaveBeenCalledOnce();
  });

  test("accepts the current promise API's singular address result", async () => {
    const resolve = vi.fn(async () => ({ address: "203.0.113.11", resultCode: 0 }));
    (globalThis as { chrome?: unknown }).chrome = {
      dns: { resolve },
      runtime: {
        getManifest: () => ({ permissions: ["dns"] }),
      },
    };

    await expect(dnsResolve("provider.example")).resolves.toEqual({
      kind: "resolved",
      ips: ["203.0.113.11"],
    });
  });

  test("reports API absence independently of manifest claims", () => {
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { getManifest: () => ({ permissions: ["dns"] }) },
    };
    expect(dnsResolverCapability()).toBe("api-unavailable");
  });
});
