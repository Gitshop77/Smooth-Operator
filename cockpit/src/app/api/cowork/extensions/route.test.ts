import type { NextRequest } from 'next/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock('@/lib/db', () => ({
  db: {
    extension: { findMany },
  },
}));

import { GET } from '@/app/api/cowork/extensions/route';

function fakeReq(query = ''): NextRequest {
  return { nextUrl: { searchParams: new URLSearchParams(query) } } as unknown as NextRequest;
}

beforeEach(() => {
  findMany.mockReset();
  findMany.mockResolvedValue([]);
});

describe('GET /api/cowork/extensions', () => {
  it('rejects non-canonical enabled values with 400', async () => {
    for (const bad of ['1', 'TRUE', 'yes']) {
      const res = await GET(fakeReq(`enabled=${bad}`));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('allowed values: true, false');
    }
    expect(findMany).not.toHaveBeenCalled();
  });

  it('forwards enabled=true as where.isEnabled true', async () => {
    await GET(fakeReq('enabled=true'));
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { isEnabled: true } }));
  });

  it('forwards enabled=false as where.isEnabled false', async () => {
    await GET(fakeReq('enabled=false'));
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { isEnabled: false } }));
  });

  it('forwards where: undefined when the param is absent', async () => {
    await GET(fakeReq());
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: undefined }));
  });

  it('projects each field exactly once with no size alias', async () => {
    findMany.mockResolvedValueOnce([
      {
        id: 'e1',
        name: 'Ext',
        version: '1.0.0',
        description: 'desc',
        manifestJson: '{}',
        isInstalled: true,
        isEnabled: true,
        source: 'store',
        trustLevel: 'trusted',
        createdAt: 'c',
        updatedAt: 'u',
        // Prisma column that must NOT leak into the projection:
        internalOnly: 'secret',
      },
    ]);
    const res = await GET(fakeReq());
    const { extensions } = await res.json();
    expect(extensions).toHaveLength(1);
    const row = extensions[0];
    expect(row).toEqual({
      id: 'e1',
      name: 'Ext',
      version: '1.0.0',
      description: 'desc',
      manifestJson: '{}',
      isInstalled: true,
      isEnabled: true,
      source: 'store',
      trustLevel: 'trusted',
      createdAt: 'c',
      updatedAt: 'u',
    });
    expect('size' in row).toBe(false);
    expect('enabled' in row).toBe(false);
    expect('installedAt' in row).toBe(false);
    expect('internalOnly' in row).toBe(false);
  });
});
