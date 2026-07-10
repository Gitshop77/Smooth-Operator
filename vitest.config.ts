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
      // Baseline thresholds (F-31). These act as a regression gate: a PR that
      // drops coverage below the measured baseline fails CI. Keep them just
      // under the current numbers so they catch real drops, not noise.
      // Measured baseline: lines 52.75%, statements 51.07%, functions 52.54%,
      // branches 42.94%.
      thresholds: {
        lines: 50,
        statements: 50,
        functions: 50,
        branches: 40,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
