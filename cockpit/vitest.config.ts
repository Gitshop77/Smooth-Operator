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
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Modest baseline regression gate. Coverage is only collected when the
      // suite is run with `--coverage`, so this does not affect normal test
      // runs. Calibrate these numbers against a first `vitest --coverage`
      // measurement; cockpit coverage is currently unmeasured and these are
      // intentionally low to avoid immediately failing opt-in coverage runs.
      thresholds: {
        lines: 20,
        statements: 20,
        functions: 20,
        branches: 10,
      },
    },
  },
  resolve: {
    alias: {
      '@': srcDir,
    },
  },
});
