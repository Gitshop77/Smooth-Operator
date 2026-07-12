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
 //
 // NOTE: no `thresholds` are configured here. Cockpit's own coverage baseline
 // has never been measured (it requires a `--coverage` run), so any threshold
 // would be an UNCALIBRATED PLACEHOLDER borrowed from the root package — a
 // number that is meaningless for this package and gives false confidence.
 // Do not ship enforcement on borrowed numbers. Once the cockpit baseline is
 // measured (one point below each metric on the first real `--coverage` run),
 // add calibrated `thresholds` here and have the cockpit CI job run
 // `npm test -- --coverage` so the gate actually executes.
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
