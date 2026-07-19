import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';

const srcDir = fileURLToPath(new URL('./src', import.meta.url));

// Cockpit-local Vitest config — intentionally self-contained.
//
// WHY THIS FILE EXISTS
// Vitest searches UP the directory tree for a config when launched without an
// explicit `--config`. If this file were absent, a `vitest run` started from
// ./cockpit would walk up to the repo root, adopt ./vitest.config.ts (whose
// `root` is the repo root and whose `include` is `tests/**/*.test.ts`), and
// wrongly execute the ENTIRE root suite (~106 files / ~1562 tests) instead of
// the cockpit tests. Pinning the config here (its location makes `root` the
// cockpit directory implicitly) and scoping `include` to ./src guarantees the
// cockpit CI job only ever runs cockpit tests. It does NOT import or extend the
// root config.
export default defineConfig({
  resolve: {
    // Cockpit tests import via the `@` alias (e.g. `@/hooks/use-toast`); this
    // mirrors the alias the Next.js app resolves at runtime.
    alias: { '@': srcDir },
  },
  test: {
    globals: false,
    // Cockpit tests are server-side units (Next middleware / route handlers,
    // Prisma queries, pure hooks & reducers). None of them render a DOM, so
    // `node` is the correct environment and avoids the heavier jsdom setup.
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    exclude: ['node_modules/**'],
    testTimeout: 30_000,
    // Isolate each test file so module-level mocks (e.g. @/lib/db) don't leak
    // ambient state into later files.
    isolate: true,
    // Coverage is opt-in: collected only when the suite is run with
    // `--coverage`. No `thresholds` are configured here — cockpit's own
    // coverage baseline has never been measured, so any threshold would be an
    // uncalibrated placeholder borrowed from the root package. Add calibrated
    // `thresholds` only after a real `--coverage` run establishes the baseline.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Scope coverage to shippable source so a future measured baseline isn't
      // polluted by tests / config files.
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/*.spec.ts',
        '**/*.spec.tsx',
        '**/*.config.ts',
      ],
    },
  },
});
