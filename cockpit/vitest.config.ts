import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';

const srcDir = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  test: {
    globals: false,
    // `node` is the default for unit/integration tests. Component tests written
    // as `*.test.tsx` get a `jsdom` environment via `environmentMatchGlobs`
    // below, so React rendering works without breaking the rest of the suite.
    environment: 'node',
    environmentMatchGlobs: [
      ['**/*.test.tsx', 'jsdom'],
      ['**/*.spec.tsx', 'jsdom'],
    ],
    // Match both `.ts` and `.tsx` test/spec files so component/integration
    // tests are not silently skipped.
    include: ['src/**/*.test.{ts,tsx}', 'src/**/*.spec.{ts,tsx}'],
    testTimeout: 30_000,
    // Isolate each test file so module-level mocks (e.g. @/lib/db) don't leak.
    isolate: true,
    // Coverage is opt-in: collected only when the suite is run with `--coverage`.
    // Thresholds below are a no-op until coverage is actually collected (i.e.
    // until the cockpit CI job runs `npm test -- --coverage` — see
    // `.github/workflows/ci.yml`, which is owned by a different batch and is the
    // actual blocker for this gate). Mirrors the root `vitest.config.ts` pattern:
    // floors are pinned just below a measured baseline so the gate stays GREEN
    // (a gate pinned above baseline fails every PR and trains contributors to
    // ignore it) and still fails on any regression below baseline.
    //
    // UNCALIBRATED PLACEHOLDER — cockpit's own baseline has not been measured
    // yet (it requires a `--coverage` run). The values below are borrowed from
    // the root package's measured baseline and MUST be replaced with cockpit's
    // own measured numbers (one point below each metric) on the first
    // `npm test -- --coverage` run, then ratcheted upward over time. Do not ship
    // enforcement on these borrowed numbers without measuring cockpit first.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      thresholds: {
        lines: 53,
        statements: 51,
        functions: 50,
        branches: 43,
      },
    },
  },
  resolve: {
    alias: {
      '@': srcDir,
    },
  },
});
