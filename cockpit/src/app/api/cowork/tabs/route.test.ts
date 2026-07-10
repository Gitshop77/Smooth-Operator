import { describe, it, expect, vi } from 'vitest';

const create = vi.fn();

vi.mock('@/lib/db', () => ({
  db: {
    tab: { create },
  },
}));

import { POST } from '@/app/api/cowork/tabs/route';
import { db } from '@/lib/db';

function reqWithBody(text: string | null): any {
  return { body: text === null ? null : {}, text: async () => text };
}

describe('POST /api/cowork/tabs (F-04b)', () => {
  it('returns 400 (not 201) on malformed JSON instead of creating a row with defaults', async () => {
    const res = await POST(reqWithBody('{ this is not valid json'));
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('still returns 400 for a well-formed but empty body (no url)', async () => {
    const res = await POST(reqWithBody('{}'));
    // No url -> badRequest, and create is never reached.
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('creates a tab for valid JSON with a url', async () => {
    create.mockResolvedValueOnce({ id: 't1', url: 'https://example.com' });
    const res = await POST(reqWithBody('{"url":"https://example.com"}'));
    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
