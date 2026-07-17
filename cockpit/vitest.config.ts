import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';

const srcDir = fileURLToPath(new URL('./src', import.meta.url));

// Vitest 4 removed `environmentMatchGlobs` and does NOT inherit the root
// `resolve.alias` when `projects` is used, so the `@` -> ./src alias must be
// declared on every project entry (and at the root for the default project).
const alias = { '@': srcDir };

export default defineConfig({
  resolve: {
    alias,
  },
  test: {
    globals: false,
    projects: [
      {
        // Default node environment for `.ts` unit & integration tests. The
        // `.tsx` component tests are intentionally excluded here so the jsdom
        // project below owns them (overlapping globs make ownership ambiguous
        // otherwise and they would run under `node`).
        resolve: { alias },
        test: {
          include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
          environment: 'node',
        },
      },
      {
        // jsdom environment for React component tests.
        resolve: { alias },
        test: {
          include: ['src/**/*.test.tsx', 'src/**/*.spec.tsx'],
          environment: 'jsdom',
        },
      },
    ],
    testTimeout: 30_000,
    // Isolate each test file so module-level mocks (e.g. @/lib/db) don't leak.
    isolate: true,
    // Coverage is opt-in: collected only when the suite is run with `--coverage`.
    //
    // NOTE: no `thresholds` are configured here. Cockpit's own coverage
    // baseline has never been measured (it requires a `--coverage` run), so any
    // threshold would be an UNCALIBRATED PLACEHOLDER borrowed from the root
    // package — a number that is meaningless for this package and gives false
    // confidence. Do not ship enforcement on borrowed numbers. Once the
    // cockpit baseline is measured (one point below each metric on the first
    // real `--coverage` run), add calibrated `thresholds` here and have the
    // cockpit CI job run `npm test -- --coverage` so the gate actually
    // executes.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Scope coverage to shippable source so the first measured baseline
      // (once `--coverage` is run) isn't polluted by tests/config files.
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['**/*.test.ts', '**/*.test.tsx', '**/*.config.ts', '**/*.config.mjs'],
    },
  },
});
