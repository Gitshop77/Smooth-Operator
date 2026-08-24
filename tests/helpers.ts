import type { ServerConfig } from "@/server/config";

export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const base: ServerConfig = {
    transport: "stdio",
    http: {
      host: "127.0.0.1",
      port: 3344,
      path: "/mcp",
      allowRemote: false,
      allowedHosts: ["127.0.0.1", "localhost"],
      allowedOrigins: ["127.0.0.1", "localhost"],
      maxBodyBytes: 2_000_000,
    },
    browser: {
      mode: "disabled",
      url: "http://127.0.0.1:9222",
      headless: true,
      autoLaunch: false,
      actionTimeoutMs: 15_000,
      connectTimeoutMs: 30_000,
      cdpTimeoutMs: 30_000,
      maxScreenshotBytes: 8_000_000,
      maxHtmlChars: 200_000,
    },
    security: {
      allowedDomains: [],
      blockedDomains: [],
      allowedFileRoots: ["/tmp/smooth-operator-test"],
      allowPrivateNetwork: false,
      allowEval: false,
    },
    dataDir: "/tmp/smooth-operator-test",
    logLevel: "error",
  };
  return {
    ...base,
    ...overrides,
    http: { ...base.http, ...overrides.http },
    browser: { ...base.browser, ...overrides.browser },
    security: { ...base.security, ...overrides.security },
  };
}
