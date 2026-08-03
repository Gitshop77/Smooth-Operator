import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: false,
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
 // Explicitly pin isolate: true so cross-file global-state leakage
 // (from tests that mutate globalThis.window/document/HTMLElement.prototype)
 // can't silently regress if pool/isolation settings change in the future.
    isolate: true,
 // `isolate: true` IS honoured by vitest v4: per-file `moduleRunner.mocker?.reset()`
 // + module re-evaluation run whenever `config.isolate` is set (see
 // node_modules/vitest/dist/chunks/base.B6Opl8PE.js in the pinned vitest
 // version), and the CLI documents `--no-isolate` (default: `true`). The setup
 // file below is kept as defense-in-depth: it resets ambient globals
 // (`globalThis.chrome`, `document.body`, `localStorage`, `fetch`) that could
 // otherwise leak across files if the isolation implementation ever changes —
 // without altering any security logic.
    setupFiles: ["./tests/helpers/test-isolation.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
  // Coverage gate — global floors are pinned one point below the measured
  // baseline so the current suite passes while still failing on any drop
  // below baseline. Ratchet upward over time, never downward.
  //
  // Measured baseline (this run): lines 71.81%, statements 69.98%,
  // functions 72.92%, branches 62.8%.
  //
  // Per-glob regression pins for security-critical modules. Each is pinned
  // just below the module's CURRENT measured coverage so the gate stays green
  // now but fails any future PR that regresses one of these guards to a lower
  // level — closing the gap where a global-only floor could mask a guard
  // module dropping to near 0%. Pins target the guard implementations directly
  // (ssrf-ipv6/ssrf-dns/ssrf-validate, security-injection); the barrel
  // re-export files (ssrf.ts, security.ts) contain no coverable statements and
  // would never trip. Ratchet each value up over time as the modules gain real
  // test coverage. The static ReDoS/SSRF/redaction guards themselves are
  // untouched by this config.
      thresholds: {
        lines: 70,
        statements: 68,
        functions: 71,
        branches: 61,
        "src/lib/agent/llm/route/ssrf-ipv6.ts": 81,
        "src/lib/agent/llm/route/ssrf-validate.ts": 91,
        "src/lib/agent/llm/route/ssrf-dns.ts": 77,
        "src/lib/agent/security-injection.ts": 93,
        "src/lib/agent/anti-bot.ts": 73,
        "src/lib/agent/anti-detection.ts": { lines: 59, statements: 56, functions: 63, branches: 42 },
        "src/lib/agent/llm/route/auth.ts": 56,
        "src/lib/agent/llm/route/endpoint.ts": 20,
      } as unknown as never,
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
