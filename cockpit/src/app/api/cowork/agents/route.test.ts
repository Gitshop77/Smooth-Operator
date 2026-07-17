import { describe, it, expect, vi } from 'vitest';

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock('@/lib/db', () => ({
  db: {
    agentTrust: { findMany },
  },
}));

import { GET } from '@/app/api/cowork/agents/route';

function getReq(query = ''): any {
  return { nextUrl: { searchParams: new URLSearchParams(query) } };
}

describe('GET /api/cowork/agents (parseAgentId boundary)', () => {
  it('rejects a control-char agentId with 400', async () => {
    const res = await GET(getReq('agentId=foo%00bar'));
    expect(res.status).toBe(400);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('rejects a >128-char agentId with 400', async () => {
    const res = await GET(getReq(`agentId=${'a'.repeat(200)}`));
    expect(res.status).toBe(400);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('accepts a valid 1-128 char agentId with 200', async () => {
    findMany.mockResolvedValueOnce([]);
    const res = await GET(getReq('agentId=agent-7'));
    expect(res.status).toBe(200);
    expect(findMany).toHaveBeenCalled();
  });
});
