import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: false,
    environment: "jsdom",
    // Give jsdom a stable, non-opaque origin. This makes Web Storage behave
    // deterministically under Node >=22 and avoids its noisy no-path fallback;
    // the test-isolation helper still supplies a per-file Map store.
    environmentOptions: {
      jsdom: { url: "https://open-cowork.test/" },
    },
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
        // Per-glob regression pins for security-critical modules. Each glob is
        // pinned ONE POINT BELOW the module's CURRENT measured coverage so the
        // gate stays green now but fails any future PR that regresses one of
        // these guards to a lower level — closing the gap where a global-only
        // floor could mask a guard module dropping to near 0%. Pins target the
        // guard implementations directly (ssrf-ipv6/ssrf-dns/ssrf-validate,
        // security-injection); the barrel re-export files (ssrf.ts,
        // security.ts) contain no coverable statements and would never trip.
        //
        // IMPORTANT (vitest v4 semantics): a bare NUMBER glob pin is silently
        // ignored by vitest v4's `checkThresholds` (all four metrics resolve
        // to undefined and the set is skipped). Every per-glob pin MUST use
        // the object form below or it is dead config. `tests/phase15-test-
        // infra.test.ts` pins this shape so a bare-number pin can never
        // silently return. Measured on 2026-08-13 (final phase 15 run):
        //   ssrf-ipv6.ts       89.23 st / 86.02 br / 100 fn / 97.4 lines
        //   ssrf-validate.ts   92.79 st / 93 br / 100 fn / 92.07 lines
        //   ssrf-dns.ts        95.08 st / 89.58 br / 91.66 fn / 100 lines
        //   security-injection 100 st / 95 br / 100 fn / 100 lines
        //   anti-bot.ts        61.85 st / 68.67 br / 47.36 fn / 65.85 lines
        //   anti-detection.ts  57.22 st / 43.15 br / 64.51 fn / 60.12 lines
        //   auth.ts            98.41 st / 94.44 br / 100 fn / 100 lines
        //   endpoint.ts        88 st / 88.23 br / 83.33 fn / 90.69 lines
        "src/lib/agent/llm/route/ssrf-ipv6.ts": { lines: 96, statements: 88, functions: 99, branches: 85 },
        "src/lib/agent/llm/route/ssrf-validate.ts": { lines: 91, statements: 91, functions: 99, branches: 92 },
        "src/lib/agent/llm/route/ssrf-dns.ts": { lines: 99, statements: 94, functions: 90, branches: 88 },
        "src/lib/agent/security-injection.ts": { lines: 99, statements: 99, functions: 99, branches: 94 },
        "src/lib/agent/anti-bot.ts": { lines: 64, statements: 60, functions: 46, branches: 67 },
        "src/lib/agent/anti-detection.ts": { lines: 59, statements: 56, functions: 63, branches: 42 },
        "src/lib/agent/llm/route/auth.ts": { lines: 99, statements: 97, functions: 99, branches: 93 },
        "src/lib/agent/llm/route/endpoint.ts": { lines: 89, statements: 87, functions: 82, branches: 87 },
      } as unknown as never,
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
