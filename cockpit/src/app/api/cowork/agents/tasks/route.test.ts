import type { NextRequest } from 'next/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock('@/lib/db', () => ({
  db: {
    task: { findMany },
  },
}));

import { GET } from '@/app/api/cowork/agents/tasks/route';

function getReq(query = ''): NextRequest {
  return { nextUrl: { searchParams: new URLSearchParams(query) } } as unknown as NextRequest;
}

// Clear call history between tests so boundary assertions (e.g. "findMany was
// not called") reflect only the current test, not earlier ones in this file.
beforeEach(() => {
  findMany.mockClear();
});

describe('GET /api/cowork/agents/tasks', () => {
  it('rejects an unknown status enum with 400', async () => {
    const res = await GET(getReq('status=bogus'));
    expect(res.status).toBe(400);
    expect(findMany).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toContain('Invalid status');
  });

  it('passes an allowed status through to the query', async () => {
    findMany.mockResolvedValueOnce([]);
    const res = await GET(getReq('status=running'));
    expect(res.status).toBe(200);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'running' } }),
    );
  });

  it('AND-combines status and agentId filters (neither silently dropped)', async () => {
    findMany.mockResolvedValueOnce([]);
    const res = await GET(getReq('status=running&agentId=agent-7'));
    expect(res.status).toBe(200);
    const where = (findMany.mock.lastCall as [{ where: unknown }])[0].where;
    expect(where).toEqual({ status: 'running', agentId: 'agent-7' });
  });

  it('passes agentId-only through to the query without a status filter', async () => {
    findMany.mockResolvedValueOnce([]);
    const res = await GET(getReq('agentId=agent-7'));
    expect(res.status).toBe(200);
    const where = (findMany.mock.lastCall as [{ where: unknown }])[0].where;
    expect(where).toEqual({ agentId: 'agent-7' });
  });

  it('rejects a control-char agentId with 400 (input-boundary guard)', async () => {
    const res = await GET(getReq('agentId=foo%00bar'));
    expect(res.status).toBe(400);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('rejects a >128-char agentId with 400 (input-boundary guard)', async () => {
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
