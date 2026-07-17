import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const { create, findMany, count, PrismaClientKnownRequestError } = vi.hoisted(() => {
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
    count: vi.fn(),
    PrismaClientKnownRequestError,
  };
});

vi.mock('@prisma/client', () => ({
  Prisma: { PrismaClientKnownRequestError },
}));

vi.mock('@/lib/db', () => ({
  db: {
    workflow: { create, findMany, count },
  },
}));

import { POST, GET } from '@/app/api/cowork/workflows/route';

function reqWithBody(text: string): any {
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
  };
}

function reqWithQuery(query: string): any {
  return {
    nextUrl: { searchParams: new URLSearchParams(query) },
  };
}

describe('POST /api/cowork/workflows', () => {
  it('rejects an invalid cron expression with 400', async () => {
    const res = await POST(reqWithBody('{"name":"w","scheduleCron":"not a cron"}'));
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toBe('scheduleCron is invalid');
  });

  it('rejects an oversized step array with 400', async () => {
    const steps = Array.from({ length: 501 }, () => ({ x: 1 }));
    const res = await POST(reqWithBody(JSON.stringify({ name: 'w', steps })));
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toBe('steps is invalid');
  });

  it('rejects oversized variables with 400', async () => {
    const variables = { big: 'x'.repeat(100_001) };
    const res = await POST(reqWithBody(JSON.stringify({ name: 'w', variables })));
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toBe('variables are too large');
  });

  it('defaults a missing name to "Untitled Workflow" and creates (201)', async () => {
    create.mockResolvedValueOnce({ id: 'w1', name: 'Untitled Workflow' });
    const res = await POST(reqWithBody('{}'));
    expect(res.status).toBe(201);
    expect(create.mock.calls[0][0].data.name).toBe('Untitled Workflow');
  });
});

describe('GET /api/cowork/workflows', () => {
  it('passes the cursor and returns nextCursor only on a full page', async () => {
    findMany.mockResolvedValueOnce(
      Array.from({ length: 5 }, (_, i) => ({
        id: `w${i}`,
        createdAt: new Date(),
        isRecurring: false,
        lastRunAt: null,
      })),
    );
    count.mockResolvedValueOnce(100);
    const res = await GET(reqWithQuery('limit=5&after=abc'));
    const body = await res.json();
    expect(body.total).toBe(100);
    expect(body.nextCursor).toBe('w4');
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: { id: 'abc' }, skip: 1, take: 5 }),
    );
  });
});
