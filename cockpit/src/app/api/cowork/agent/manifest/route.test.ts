/**
 * Agent manifest endpoint/path invariant.
 *
 * `agent/manifest/route.ts` documents that every `endpoints.*.path` corresponds
 * to a real route module on disk, so agents consuming the manifest never hit a
 * 404. This test enforces that contract: it loads the manifest, collects every
 * advertised path, and asserts each resolves to an actual `route.ts` under
 * `src/app/api/cowork/*`. A renamed/removed route leaves a dangling path that
 * fails this test (drift detection).
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { GET } from '@/app/api/cowork/agent/manifest/route';

const __dirname = dirname(fileURLToPath(import.meta.url));
// From this file (.../cowork/agent/manifest/route.test.ts) the /api/cowork root
// is two levels up.
const API_COWORK_ROOT = join(__dirname, '..', '..');

// Recursively collect every `path` string nested anywhere under `endpoints`.
function collectPaths(node: unknown, acc: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectPaths(item, acc);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'path' && typeof v === 'string') acc.push(v);
      else collectPaths(v, acc);
    }
  }
  return acc;
}

describe('agent manifest endpoint/path invariant', () => {
  it('every advertised endpoint path resolves to a real route module', async () => {
    const res = await GET({ headers: { get: () => null } } as never);
    expect(res.status).toBe(200);
    const manifest = await res.json();
    const paths = collectPaths(manifest.endpoints);
    expect(paths.length).toBeGreaterThan(0);

    for (const p of paths) {
      expect(p.startsWith('/api/cowork')).toBe(true);
      const rel = p.replace(/^\/api\/cowork\/?/, '');
      const routeFile = join(API_COWORK_ROOT, rel, 'route.ts');
      expect(existsSync(routeFile), `missing route module for ${p} (${routeFile})`).toBe(true);
    }
  });
});
