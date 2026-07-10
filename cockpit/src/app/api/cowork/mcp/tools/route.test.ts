import { describe, it, expect } from 'vitest';
import { GET } from '@/app/api/cowork/mcp/tools/route';

function fakeReq(query = ''): any {
  return { nextUrl: { searchParams: new URLSearchParams(query) } };
}

describe('GET /api/cowork/mcp/tools (F-28)', () => {
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

  it('still supports the q filter', async () => {
    const res = await GET(fakeReq('q=bookmark'));
    const body = await res.json();
    expect(body.tools.length).toBeGreaterThan(0);
    expect(body.tools.every((t: any) => t.name.includes('bookmark') || t.description.includes('bookmark'))).toBe(true);
  });
});
