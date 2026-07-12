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
    // Coverage is opt-in: collected only when the suite is run with
    // `--coverage`. The cockpit CI job does not currently invoke `--coverage`,
    // so a `thresholds` gate here would be a silent no-op that gives false
    // assurance of coverage protection. Thresholds are intentionally omitted
    // until the CI job runs `npm test -- --coverage` (matching the root job),
    // at which point a calibrated gate should be added here.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
  resolve: {
    alias: {
      '@': srcDir,
    },
  },
});
