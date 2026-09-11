import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    isolate: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/server/**/*.ts"],
      exclude: [
        "src/server/main.ts",
        "src/server/http.ts",
      ],
      thresholds: {
        lines: 72.7,
        statements: 70.7,
        functions: 77.2,
        branches: 64.7,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve("src"),
    },
  },
});
