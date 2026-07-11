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
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // Regression gate. Thresholds are intentionally pinned ABOVE the measured
      // baseline so the gate actually drives coverage upward and catches new
      // untested code — NOT "just below baseline", which only guards against
      // noise and lets ~half the codebase stay untested (see FULL-REVIEW #6/#7).
      //
      // These are a deliberate first increment toward the real targets
      // (lines 70 / statements 70 / functions 70 / branches 60). Once the suite
      // is green (FULL-REVIEW #2) and coverage climbs past these values, bump
      // them toward those targets. Sitting above baseline means the gate yields
      // a signal as soon as the suite goes green, instead of being masked by the
      // currently-red run.
      //
      // Measured baseline (pre-fix): lines 52.75%, statements 51.07%,
      // functions 52.54%, branches 42.94%.
      //
      // NOTE: per-directory floors for security-critical modules were also
      // recommended, but the named modules (lib/agent/secrets, llm/providers,
      // tools/handlers) do not exist in this repository. Add per-glob thresholds
      // here for the actual secret/provider-handling modules once coverage for
      // those paths is measurable.
      thresholds: {
        lines: 60,
        statements: 58,
        functions: 60,
        branches: 50,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
