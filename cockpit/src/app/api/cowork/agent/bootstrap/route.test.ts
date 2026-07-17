import { describe, it, expect, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { redactSecrets } from '@/lib/cowork/api/http';

const { getVersion, getBaseUrl, buildAgentBootstrapContract } = vi.hoisted(() => ({
  getVersion: vi.fn(),
  getBaseUrl: vi.fn(),
  buildAgentBootstrapContract: vi.fn(),
}));

// Spread the real module so the other discovery routes (manifest/version) can
// be exercised with their real capability exports, while still letting the
// bootstrap route be driven by the three mocked builders above.
vi.mock('@/lib/cowork/api/agent-bootstrap', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/cowork/api/agent-bootstrap')>();
  return {
    ...actual,
    getVersion,
    getBaseUrl,
    buildAgentBootstrapContract,
  };
});

import { GET } from '@/app/api/cowork/agent/bootstrap/route';
import { GET as GET_MANIFEST } from '@/app/api/cowork/agent/manifest/route';
import { GET as GET_VERSION } from '@/app/api/cowork/agent/version/route';

describe('GET /api/cowork/agent/bootstrap', () => {
  it('returns 200 with a bootstrap contract built from version + baseUrl', async () => {
    getVersion.mockReturnValue('0.3.1');
    getBaseUrl.mockReturnValue('http://localhost:3000');
    buildAgentBootstrapContract.mockReturnValue({
      identity: { name: 'cowork-cockpit', version: '0.3.1', baseUrl: 'http://localhost:3000' },
    });

    const res = await GET({
      headers: new Headers(),
    } as unknown as NextRequest);

    expect(res.status).toBe(200);
    expect(buildAgentBootstrapContract).toHaveBeenCalledWith('http://localhost:3000', '0.3.1');
    const body = await res.json();
    expect(body.identity.version).toBe('0.3.1');
    expect(redactSecrets(JSON.stringify(body))).toBe(JSON.stringify(body));
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
  });

  it('returns a fail-closed 500 with a correlationId on internal error', async () => {
    buildAgentBootstrapContract.mockImplementation(() => {
      throw new Error('boom');
    });

    const res = await GET({
      headers: new Headers(),
    } as unknown as NextRequest);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('internal_error');
    expect(typeof body.correlationId).toBe('string');
  });
});

// The existing mocked test above only verifies the builder was CALLED with the
// right args; it never inspects the actual contract contents. This block
// imports the REAL builder and asserts the contract an LLM agent receives
// contains only public fields and no secret-shaped values — a regression that
// injects a token/URL-credential into the real contract is caught here.
describe('GET /api/cowork/agent/bootstrap — real contract contents', () => {
  it('returns only public fields and no secret-shaped values', async () => {
    const actual = await vi.importActual<typeof import('@/lib/cowork/api/agent-bootstrap')>(
      '@/lib/cowork/api/agent-bootstrap',
    );
    const baseUrl = actual.getBaseUrl();
    const version = actual.getVersion();
    const contract = actual.buildAgentBootstrapContract(baseUrl, version);

    expect(contract.identity.name).toBe('cowork-cockpit');
    expect(contract.identity.baseUrl).toBe(baseUrl);
    expect(Array.isArray(contract.capabilityFamilies)).toBe(true);
    expect(Array.isArray(contract.operatingRules)).toBe(true);

    const serialized = JSON.stringify(contract);
    expect(redactSecrets(serialized)).toBe(serialized);

    // Defense-in-depth companion: the manifest and version discovery surfaces
    // also embed getBaseUrl() and must not leak a secret-shaped value through
    // their route output. Drive the real route handlers (with the mocked
    // getBaseUrl/getVersion now returning the real values) so a future change
    // that injects a token/credential into either JSON response is caught.
    getBaseUrl.mockReturnValue(baseUrl);
    getVersion.mockReturnValue(version);

    const manifestRes = await GET_MANIFEST({ headers: { get: () => null } } as never);
    expect(manifestRes.status).toBe(200);
    const manifestJson = JSON.stringify(await manifestRes.json());
    expect(redactSecrets(manifestJson)).toBe(manifestJson);

    const versionRes = await GET_VERSION({ headers: { get: () => null } } as never);
    expect(versionRes.status).toBe(200);
    const versionJson = JSON.stringify(await versionRes.json());
    expect(redactSecrets(versionJson)).toBe(versionJson);
  });
});
