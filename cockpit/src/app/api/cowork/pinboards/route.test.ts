import { describe, it, expect, vi, afterEach } from 'vitest';

const { create, findMany, count } = vi.hoisted(() => ({
  create: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    pinboard: { create, findMany, count },
  },
}));

import { POST } from '@/app/api/cowork/pinboards/route';

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

describe('POST /api/cowork/pinboards', () => {
  it('falls back to the default color when an invalid color is supplied', async () => {
    create.mockResolvedValueOnce({ id: 'p1', name: 'x', color: '#4285f4' });
    const res = await POST(reqWithBody('{"name":"x","color":"not-a-color"}'));
    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ color: '#4285f4' }) }));
    const pb = (await res.json()).pinboard;
    expect(pb.color).toBe('#4285f4');
  });

  it('accepts a valid hex color', async () => {
    create.mockResolvedValueOnce({ id: 'p2', name: 'y', color: '#abcdef' });
    const res = await POST(reqWithBody('{"name":"y","color":"#abcdef"}'));
    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ color: '#abcdef' }) }));
  });
});
