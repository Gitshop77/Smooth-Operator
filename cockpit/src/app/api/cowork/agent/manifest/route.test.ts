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
import { GET as GET_AGENT } from '@/app/api/cowork/agent/route';
import { redactSecrets } from '@/lib/cowork/api/http';

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

  // AU-3: the manifest must NOT advertise the `?all=`/`?all=1` mass-delete
  // mechanism. Bulk erasure requires server-side `confirm:true` and is
  // deliberately undocumented; a future edit that "helpfully" adds an `all=`
  // form to a DELETE description would silently disclose the bulk-erase path to
  // agents. This locks the advertised delete contract to the id/session forms.
  it('never advertises the ?all= mass-delete parameter anywhere in the manifest', async () => {
    const res = await GET({ headers: { get: () => null } } as never);
    const manifest = await res.json();

    // Scan EVERY string value in the manifest — not just DELETE descriptions.
    // The bulk-erase param must never be disclosed in any prose field
    // (descriptions of any method, operatingRules, notes, etc.).
    const strings: string[] = [];
    const collect = (node: unknown) => {
      if (typeof node === 'string') {
        strings.push(node);
      } else if (Array.isArray(node)) {
        for (const item of node) collect(item);
      } else if (node && typeof node === 'object') {
        for (const v of Object.values(node as Record<string, unknown>)) collect(v);
      }
    };
    collect(manifest);

    expect(strings.length).toBeGreaterThan(0);
    for (const s of strings) {
      expect(s).not.toMatch(/all=/);
    }
  });

  // AU-3 companion: the human-readable /agent Markdown page is an advertised
  // agent-facing discovery surface (docs.humanReadable). The same ?all=
  // mass-delete disclosure must never appear there, so a future edit to its
  // prose cannot silently disclose the bulk-erase mechanism to consuming agents.
  it('never advertises the ?all= mass-delete parameter in the /agent markdown page', async () => {
    const res = await GET_AGENT({ headers: { get: () => null } } as never);
    expect(res.status).toBe(200);
    const md = await res.text();
    expect(md).not.toMatch(/all=/);
    // Defense-in-depth: a secret-shaped value (e.g. a credential baked into
    // COWORK_BASE_URL or getVersion) must never leak through this discovery
    // surface. Mirrors the redaction guard on the bootstrap/manifest/version
    // routes.
    expect(redactSecrets(md)).toBe(md);
  });
});
