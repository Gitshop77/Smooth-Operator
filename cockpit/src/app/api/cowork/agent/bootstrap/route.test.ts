import { describe, it, expect, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { getVersion, getBaseUrl, buildAgentBootstrapContract } = vi.hoisted(() => ({
  getVersion: vi.fn(),
  getBaseUrl: vi.fn(),
  buildAgentBootstrapContract: vi.fn(),
}));

vi.mock('@/lib/cowork/api/agent-bootstrap', () => ({
  getVersion,
  getBaseUrl,
  buildAgentBootstrapContract,
}));

import { GET } from '@/app/api/cowork/agent/bootstrap/route';

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
