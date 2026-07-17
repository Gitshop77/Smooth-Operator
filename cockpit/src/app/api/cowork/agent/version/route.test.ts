import { describe, it, expect } from 'vitest';
import type { NextRequest } from 'next/server';
import { redactSecrets } from '@/lib/cowork/api/http';
import { GET } from '@/app/api/cowork/agent/version/route';

// The /agent/version route is one of the 5 PUBLIC (unauthenticated) discovery
// routes. It must surface only public, non-sensitive fields — never a token,
// key, or credentialed URL. These assertions lock the response to a public-only
// shape and detect any accidental secret inclusion by reusing the canonical
// `redactSecrets` key-shape patterns: if the serialized body changes under
// redaction, a secret-shaped value was disclosed.
describe('GET /api/cowork/agent/version', () => {
  it('returns a public-only contract with no secret-shaped values', async () => {
    const res = await GET({ headers: new Headers() } as unknown as NextRequest);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');

    const body = await res.json();
    expect(body.name).toBe('cowork-cockpit');
    expect(typeof body.version).toBe('string');
    expect(Array.isArray(body.capabilityFamilies)).toBe(true);
    expect(body.authMethods).toEqual([]);
    expect(body.dataRouteAuth).toBeDefined();
    expect(body.transports).toBeDefined();
    expect(body.pairingSupported).toBe(false);

    const serialized = JSON.stringify(body);
    expect(redactSecrets(serialized)).toBe(serialized);
  });
});
