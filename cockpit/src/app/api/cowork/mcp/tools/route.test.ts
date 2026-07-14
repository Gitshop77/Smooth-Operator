import { describe, it, expect } from 'vitest';
import type { NextRequest } from 'next/server';
import { GET } from '@/app/api/cowork/mcp/tools/route';

function fakeReq(query = ''): NextRequest {
  return {
    nextUrl: { searchParams: new URLSearchParams(query) },
    headers: { get: () => null },
  } as unknown as NextRequest;
}

describe('GET /api/cowork/mcp/tools', () => {
  it('marks every tool as implemented:false and includes an aspirational note', async () => {
    const res = await GET(fakeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.note).toBe('string');
    expect(body.note.length).toBeGreaterThan(0);
    expect(typeof body.description).toBe('string');
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.length).toBeGreaterThan(0);
 // Every advertised tool must be flagged as not-yet-served.
    expect(body.tools.every((t: any) => t.implemented === false)).toBe(true);
    expect(body.total).toBe(body.tools.length);
    expect(body.totalCatalog).toBe(body.tools.length);
  });

  it('still supports the q filter (case-insensitive)', async () => {
    const res = await GET(fakeReq('q=BOOKMARK'));
    const body = await res.json();
    expect(body.tools.length).toBeGreaterThan(0);
    expect(
      body.tools.every(
        (t: any) =>
          t.name.toLowerCase().includes('bookmark') ||
          t.description.toLowerCase().includes('bookmark'),
      ),
    ).toBe(true);
  });

  it('filters by category', async () => {
    const res = await GET(fakeReq('category=bookmarks'));
    const body = await res.json();
    expect(body.tools.length).toBeGreaterThan(0);
    expect(body.tools.every((t: any) => t.category === 'bookmarks')).toBe(true);
  });
});
