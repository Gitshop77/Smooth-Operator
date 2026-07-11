import { describe, it, expect, vi, afterEach } from 'vitest';

import { POST } from '@/app/api/cowork/extensions/log/route';

function fakeReq(body: unknown): any {
  return {
    nextUrl: { searchParams: new URLSearchParams('') },
    body: true,
    text: async () => JSON.stringify(body),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/cowork/extensions/log', () => {
  it('returns 200 and emits a structured log line', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await POST(fakeReq({ source: 'SW', msg: 'hello' }));
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    const arg = spy.mock.calls[0][1] as { source: string; message: string; stack: string };
    expect(arg.source).toBe('SW');
    expect(arg.message).toBe('hello');
  });

  it('strips CRLF from attacker-controlled fields (log-line forgery defense)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const forged = 'benign\n[SW:EVIL] injected log line\r\nsecond';
    await POST(fakeReq({ source: 'SW', msg: forged }));
    const arg = spy.mock.calls[0][1] as { message: string };
    expect(arg.message).not.toContain('\n');
    expect(arg.message).not.toContain('\r');
    expect(arg.message).toBe('benign [SW:EVIL] injected log line  second');
  });

  it('caps oversized fields (length bound)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const huge = 'x'.repeat(10_000);
    await POST(fakeReq({ source: 'SW', msg: huge }));
    const arg = spy.mock.calls[0][1] as { message: string };
    expect(arg.message.length).toBeLessThanOrEqual(4096);
  });

  it('handles non-string fields without throwing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await POST(fakeReq({ source: 123, msg: null, stack: { nested: true } }));
    expect(res.status).toBe(200);
    const arg = spy.mock.calls[0][1] as { source: string; message: string };
    expect(arg.source).toBe('');
    expect(arg.message).toBe('(no message)');
  });
});
