import { describe, it, expect, vi, afterEach } from 'vitest';

// Mock Prisma so no real DB is touched. The route creates bookmarks inside a
// `db.$transaction` callback that receives a `tx` with `bookmark.findUnique`
// (parent existence check) and `bookmark.create`.
const { findMany, txFindUnique, txCreate } = vi.hoisted(() => ({
  findMany: vi.fn(),
  txFindUnique: vi.fn(),
  txCreate: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    bookmark: { findMany },
    $transaction: (cb: any) => cb({ bookmark: { findUnique: txFindUnique, create: txCreate } }),
  },
}));

import { GET, POST } from '@/app/api/cowork/bookmarks/route';

afterEach(() => {
  vi.clearAllMocks();
});

function reqWithBody(body?: unknown): any {
  const headers = new Headers();
  if (body === undefined) {
    return { nextUrl: { searchParams: new URLSearchParams() }, headers, body: null };
  }
  const chunk = new TextEncoder().encode(JSON.stringify(body));
  return {
    nextUrl: { searchParams: new URLSearchParams() },
    headers,
    body: {
      getReader() {
        let done = false;
        return {
          async read() {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: chunk };
          },
          async cancel() {},
        };
      },
    },
  };
}

describe('POST /api/cowork/bookmarks', () => {
  it('locks the SSRF guard: rejects a loopback URL with 400', async () => {
    const res = await POST(reqWithBody({ name: 'local', url: 'http://localhost:3000' }));
    expect(res.status).toBe(400);
    expect(txCreate).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toBe('URL host is not allowed');
  });

  it('creates a folder with url:null and 201', async () => {
    txCreate.mockResolvedValueOnce({ id: 'f1', type: 'folder', name: 'x', url: null, parentId: null });
    const res = await POST(reqWithBody({ type: 'folder', name: 'x' }));
    expect(res.status).toBe(201);
    const bm = (await res.json()).bookmark;
    expect(bm.url).toBeNull();
    expect(bm.type).toBe('folder');
    expect(txCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'folder', url: null }) }),
    );
  });

  it('rejects a url whose parentId does not exist (400 unknown parentId)', async () => {
    txFindUnique.mockResolvedValueOnce(null);
    const res = await POST(reqWithBody({ url: 'https://a.com', parentId: 'missing' }));
    expect(res.status).toBe(400);
    expect(txCreate).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toBe('unknown parentId');
  });

  it('rejects a non-http(s) URL with 400', async () => {
    const res = await POST(reqWithBody({ name: 'x', url: 'ftp://example.com' }));
    expect(res.status).toBe(400);
    expect(txCreate).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toBe('URL must be http or https');
  });

  it.each([
    ['loopback IPv4', 'http://127.0.0.1/'],
    ['RFC1918 class C', 'http://192.168.0.1/'],
    ['RFC1918 class A', 'http://10.0.0.1/'],
    ['cloud-metadata link-local', 'http://169.254.169.254/latest/meta-data/'],
    ['IPv6 loopback', 'http://[::1]/'],
    ['decimal-encoded IPv4', 'http://2130706433/'],
    ['hex-encoded IPv4', 'http://0x7f.0.0.1/'],
  ])('rejects %s via the SSRF guard with 400', async (_label, url) => {
    const res = await POST(reqWithBody({ name: 'x', url }));
    expect(res.status).toBe(400);
    expect(txCreate).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toBe('URL host is not allowed');
  });

  it('rejects an unknown type with 400 instead of coercing to url', async () => {
    const res = await POST(reqWithBody({ name: 'x', url: 'https://a.com', type: 'weird' }));
    expect(res.status).toBe(400);
    expect(txCreate).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toBe('type must be "url" or "folder"');
  });
});

describe('GET /api/cowork/bookmarks', () => {
  it('builds a nested tree from flat rows', async () => {
    const rows = [
      { id: 'r', name: 'root', url: null, parentId: null, type: 'folder', dateAdded: new Date('2024-01-01') },
      { id: 'c', name: 'child', url: 'https://a.com', parentId: 'r', type: 'url', dateAdded: new Date('2024-01-02') },
    ];
    findMany.mockResolvedValueOnce(rows);
    findMany.mockResolvedValue([]);
    const res = await GET(reqWithBody());
    const body = await res.json();
    expect(body.bookmarks).toHaveLength(1);
    const root = body.bookmarks[0];
    expect(root.id).toBe('r');
    expect((root as any).children).toHaveLength(1);
    expect((root as any).children[0].id).toBe('c');
  });

  it('survives a cyclic parentId without crashing', async () => {
    const rows = [
      { id: 'r', name: 'cycle', url: null, parentId: 'r', type: 'folder', dateAdded: new Date('2024-01-01') },
    ];
    findMany.mockResolvedValueOnce(rows);
    findMany.mockResolvedValue([]);
    const res = await GET(reqWithBody());
    expect(res.status).toBe(200);
    const body = await res.json();
    // A self-referential node cannot attach to a root, so it is reported as an
    // orphan rather than triggering infinite recursion / a 500.
    expect(body.bookmarks).toHaveLength(0);
    expect(body.orphans).toHaveLength(1);
  });
});
