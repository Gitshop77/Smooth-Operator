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
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
