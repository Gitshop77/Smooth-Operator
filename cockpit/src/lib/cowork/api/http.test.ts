import { describe, it, expect, vi } from 'vitest';
import { withRouteError, bodyJson, bodyJsonOptional, isSsrfSafeUrl, validateHttpUrl } from '@/lib/cowork/api/http';
import { POST as tabsPost } from '@/app/api/cowork/tabs/route';
import { POST as bookmarksPost } from '@/app/api/cowork/bookmarks/route';
import { POST as workflowsPost } from '@/app/api/cowork/workflows/route';
import { POST as sessionsPost } from '@/app/api/cowork/sessions/route';

// Mock Prisma so route handlers can be exercised without a live DB.
const created: any[] = [];
vi.mock('@/lib/db', () => ({
  db: {
    tab: {
      create: vi.fn(async (a: any) => { created.push(a.data); return a.data; }),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    workspace: { findUnique: vi.fn(async () => ({ id: 'ws1', name: 'ws' })) },
    bookmark: {
      create: vi.fn(async (a: any) => { created.push(a.data); return a.data; }),
      findMany: vi.fn(async () => []),
    },
    workflow: {
      create: vi.fn(async (a: any) => { created.push(a.data); return a.data; }),
      findMany: vi.fn(async () => []),
    },
    session: {
      create: vi.fn(async (a: any) => { created.push(a.data); return a.data; }),
    },
  },
}));

// Minimal fake of the bits of NextRequest that bodyJson touches.
function fakeReq(body: unknown, text: string): any {
  return { body, text: async () => text };
}

// A POST-style NextRequest: needs a truthy `body` (bodyJson checks it) and a
// `text()` that yields the JSON payload.
function fakePostReq(body: Record<string, unknown>): any {
  return {
    body: {},
    text: async () => JSON.stringify(body),
    nextUrl: { searchParams: new URLSearchParams() },
  };
}

describe('bodyJson (F-04b)', () => {
  it('returns {} when there is no body', async () => {
    const result = await bodyJson(fakeReq(null, ''));
    expect(result).toEqual({});
  });

  it('returns {} when the body text is empty', async () => {
    const result = await bodyJson(fakeReq({}, ''));
    expect(result).toEqual({});
  });

  it('parses valid JSON', async () => {
    const result = await bodyJson(fakeReq({}, '{"a":1,"b":"x"}'));
    expect(result).toEqual({ a: 1, b: 'x' });
  });

  it('THROWS on malformed (non-empty) JSON instead of returning {}', async () => {
    await expect(bodyJson(fakeReq({}, '{bad json'))).rejects.toThrow();
  });
});

describe('bodyJsonOptional (F-04b tolerant variant)', () => {
  it('returns {} for an absent body', async () => {
    expect(await bodyJsonOptional(fakeReq(null, ''))).toEqual({});
  });

  it('returns {} for an empty body', async () => {
    expect(await bodyJsonOptional(fakeReq({}, ''))).toEqual({});
  });

  it('parses valid JSON', async () => {
    expect(await bodyJsonOptional(fakeReq({}, '{"x":1}'))).toEqual({ x: 1 });
  });

  it('NEVER throws — returns {} on malformed JSON (unlike bodyJson)', async () => {
    await expect(bodyJsonOptional(fakeReq({}, '{bad json'))).resolves.toEqual({});
  });
});

describe('withRouteError (F-04a)', () => {
  it('hides raw internal error detail and returns a generic message + correlationId', async () => {
    const res = await withRouteError(async () => {
      throw new Error('PrismaClientKnownRequestError: table "User" column "email" unique constraint failed at /Users/app/db');
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    // Raw message must NOT be echoed.
    expect(body.error).toBe('internal_error');
    expect(JSON.stringify(body)).not.toContain('PrismaClientKnownRequestError');
    expect(JSON.stringify(body)).not.toContain('/Users/app');
    // A correlation id is present for server-log tracing.
    expect(typeof body.correlationId).toBe('string');
    expect(body.correlationId.length).toBeGreaterThan(0);
  });

  it('passes through known-safe validation messages (e.g. "required")', async () => {
    const res = await withRouteError(async () => {
      throw new Error('url is required');
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('url is required');
    expect(typeof body.correlationId).toBe('string');
  });

  it('turns a malformed-body throw into a 400 with the safe message', async () => {
    const res = await withRouteError(async () => {
      const b = await bodyJson(fakeReq({}, '{bad'));
      return new Response(JSON.stringify(b));
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid JSON body');
  });
});

describe('isSsrfSafeUrl', () => {
  it('blocks localhost / loopback / metadata / RFC1918 hosts', () => {
    expect(isSsrfSafeUrl('http://localhost/')).toBe(false);
    expect(isSsrfSafeUrl('http://127.0.0.1/')).toBe(false);
    expect(isSsrfSafeUrl('http://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(isSsrfSafeUrl('http://10.0.0.1/')).toBe(false);
    expect(isSsrfSafeUrl('http://192.168.1.1/')).toBe(false);
    expect(isSsrfSafeUrl('http://172.16.5.4/')).toBe(false);
    expect(isSsrfSafeUrl('http://0.0.0.0/')).toBe(false);
    expect(isSsrfSafeUrl('http://[::1]/')).toBe(false);
  });

  it('allows public hosts', () => {
    expect(isSsrfSafeUrl('https://example.com/')).toBe(true);
    expect(isSsrfSafeUrl('http://8.8.8.8/')).toBe(true);
  });

  it('rejects non-http(s) and invalid URLs', () => {
    expect(isSsrfSafeUrl('file:///etc/passwd')).toBe(false);
    expect(isSsrfSafeUrl('javascript:alert(1)')).toBe(false);
    expect(isSsrfSafeUrl('not a url')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stored URLs must be SSRF-safe. The storage routes (tabs/bookmarks) now
// enforce `isSsrfSafeUrl` at ingest so a stored URL can never later become an
// SSRF sink. These tests drive the actual route handlers (db mocked).
// ---------------------------------------------------------------------------
describe('stored-URL SSRF boundary — tabs route', () => {
  it('rejects http://169.254.169.254 (cloud metadata) with 400', async () => {
    const res = await tabsPost(fakePostReq({ url: 'http://169.254.169.254/latest/meta-data/', workspaceId: 'ws1' }));
    expect(res.status).toBe(400);
  });

  it('rejects http://localhost (loopback) with 400', async () => {
    const res = await tabsPost(fakePostReq({ url: 'http://localhost/', workspaceId: 'ws1' }));
    expect(res.status).toBe(400);
  });

  it('accepts https://example.com with 201', async () => {
    const res = await tabsPost(fakePostReq({ url: 'https://example.com/', workspaceId: 'ws1' }));
    expect(res.status).toBe(201);
  });
});

describe('stored-URL SSRF boundary — bookmarks route', () => {
  it('rejects http://169.254.169.254 (cloud metadata) with 400', async () => {
    const res = await bookmarksPost(fakePostReq({ name: 'x', url: 'http://169.254.169.254/latest/meta-data/', type: 'url' }));
    expect(res.status).toBe(400);
  });

  it('accepts https://example.com with 201', async () => {
    const res = await bookmarksPost(fakePostReq({ name: 'x', url: 'https://example.com/', type: 'url' }));
    expect(res.status).toBe(201);
  });

  it('still allows folder bookmarks (no URL)', async () => {
    const res = await bookmarksPost(fakePostReq({ name: 'folder', type: 'folder' }));
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Request fields are zod-validated / bounded before storage.
// ---------------------------------------------------------------------------
describe('request validation — workflows scheduleCron', () => {
  it('accepts a valid 5-field cron expression with 201', async () => {
    const res = await workflowsPost(fakePostReq({ name: 'wf', scheduleCron: '*/5 * * * *' }));
    expect(res.status).toBe(201);
    expect(created.some((c) => c.scheduleCron === '*/5 * * * *')).toBe(true);
  });

  it('rejects a cron expression containing shell metacharacters with 400', async () => {
    const res = await workflowsPost(fakePostReq({ name: 'wf', scheduleCron: '; rm -rf /' }));
    expect(res.status).toBe(400);
  });

  it('rejects a cron expression with wrong field count with 400', async () => {
    const res = await workflowsPost(fakePostReq({ name: 'wf', scheduleCron: '* * *' }));
    expect(res.status).toBe(400);
  });

  it('accepts a missing scheduleCron (stored as null)', async () => {
    const res = await workflowsPost(fakePostReq({ name: 'wf' }));
    expect(res.status).toBe(201);
    expect(created.some((c) => c.scheduleCron === null)).toBe(true);
  });
});

describe('request validation — sessions userAgent bounded', () => {
  it('truncates an over-long userAgent to 512 chars and stores it', async () => {
    const res = await sessionsPost(fakePostReq({ name: 's', userAgent: 'A'.repeat(800) }));
    expect(res.status).toBe(201);
    const stored = created.find((c) => c.userAgent && c.userAgent.length === 512);
    expect(stored).toBeTruthy();
  });

  it('rejects a userAgent that is not a string with 400', async () => {
    const res = await sessionsPost(fakePostReq({ name: 's', userAgent: { bad: true } as any }));
    expect(res.status).toBe(400);
  });
});
