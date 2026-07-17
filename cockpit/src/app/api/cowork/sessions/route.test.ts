import type { NextRequest } from 'next/server';
import { describe, it, expect, vi, afterEach } from 'vitest';

const { create, findMany, PrismaClientKnownRequestError } = vi.hoisted(() => {
  class PrismaClientKnownRequestError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'PrismaClientKnownRequestError';
      this.code = code;
    }
  }
  return {
    create: vi.fn(),
    findMany: vi.fn(),
    PrismaClientKnownRequestError,
  };
});

vi.mock('@prisma/client', () => ({
  Prisma: { PrismaClientKnownRequestError },
}));

vi.mock('@/lib/db', () => ({
  db: {
    session: { create, findMany },
  },
}));

import { POST, GET } from '@/app/api/cowork/sessions/route';

afterEach(() => {
  vi.clearAllMocks();
});

function reqWithBody(text: string): NextRequest {
  const chunk = new TextEncoder().encode(text);
  return {
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
    headers: { get: () => null },
  } as unknown as NextRequest;
}

describe('POST /api/cowork/sessions', () => {
  it('rejects a duplicate name with 400 (P2002)', async () => {
    const err = new PrismaClientKnownRequestError('Unique constraint failed', 'P2002');
    create.mockRejectedValueOnce(err);
    const res = await POST(reqWithBody('{"name":"dup"}'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('name already exists');
  });

  it('rejects a non-string userAgent with 400', async () => {
    const res = await POST(reqWithBody('{"name":"ok","userAgent":123}'));
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only name with 400', async () => {
    const res = await POST(reqWithBody('{"name":"   "}'));
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('creates a valid session (201) with a persist: partition', async () => {
    create.mockResolvedValueOnce({
      id: 's1',
      name: 'My Session',
      partition: 'persist:my-session',
      isIncognito: false,
      userAgent: null,
    });
    const res = await POST(reqWithBody('{"name":"My Session"}'));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.session.partition.startsWith('persist:')).toBe(true);
    expect(create.mock.calls[0][0].data.name).toBe('My Session');
  });
});

describe('GET /api/cowork/sessions', () => {
  it('projects isIncognito to the legacy incognito alias', async () => {
    findMany.mockResolvedValueOnce([{ id: 's1', isIncognito: true, name: 'n' }]);
    const res = await GET({ nextUrl: { searchParams: new URLSearchParams() } } as unknown as NextRequest);
    const body = await res.json();
    expect(body.sessions[0].incognito).toBe(true);
  });
});
