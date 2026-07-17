import { describe, it, expect, vi, afterEach } from 'vitest';

const { create, findMany } = vi.hoisted(() => ({
  create: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    workspace: { create, findMany },
  },
}));

import { POST } from '@/app/api/cowork/workspaces/route';

afterEach(() => {
  vi.clearAllMocks();
});

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

describe('POST /api/cowork/workspaces', () => {
  it('falls back to the default color when an invalid color is supplied', async () => {
    create.mockResolvedValueOnce({ id: 'w1', name: 'x', color: '#4285f4', emoji: '📁' });
    const res = await POST(reqWithBody('{"name":"x","color":"bad-color"}'));
    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ color: '#4285f4' }) }));
    const ws = (await res.json()).workspace;
    expect(ws.color).toBe('#4285f4');
  });

  it('rejects an over-long emoji with 400', async () => {
    // 9 chars exceeds the 8-char emoji cap.
    const res = await POST(reqWithBody('{"name":"x","emoji":"aaaaaaaaa"}'));
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toContain('emoji must be at most 8 characters');
  });
});
