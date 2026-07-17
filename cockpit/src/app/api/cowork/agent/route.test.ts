import { describe, it, expect } from 'vitest';
import type { NextRequest } from 'next/server';
import { redactSecrets } from '@/lib/cowork/api/http';
import { GET } from '@/app/api/cowork/agent/route';

// The /agent route is a PUBLIC (unauthenticated) discovery page that agents
// read first. It interpolates getVersion()/getBaseUrl() and static families/
// rules. It must stay public-by-design: no token, key, or credentialed URL may
// leak into the rendered markdown. `redactSecrets` reuses the canonical
// key-shape patterns so any accidental secret inclusion fails the test.
describe('GET /api/cowork/agent', () => {
  it('renders a public markdown bootstrap page with no secret-shaped values', async () => {
    const res = await GET({ headers: new Headers() } as unknown as NextRequest);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');

    const md = await res.text();
    expect(md).toContain('# Cowork Cockpit — Agent Bootstrap');
    expect(md).toContain('**Version:**');
    expect(md).toContain('## Capability families');
    expect(md).toContain('## Operating rules');

    expect(redactSecrets(md)).toBe(md);
  });
});
