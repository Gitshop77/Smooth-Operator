import { describe, it, expect, vi } from 'vitest';

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

    const res = await GET({} as unknown as import('next/server').NextRequest);

    expect(res.status).toBe(200);
    expect(buildAgentBootstrapContract).toHaveBeenCalledWith('http://localhost:3000', '0.3.1');
    const body = await res.json();
    expect(body.identity.version).toBe('0.3.1');
  });
});
