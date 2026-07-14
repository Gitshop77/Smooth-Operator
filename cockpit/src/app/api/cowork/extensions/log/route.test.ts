import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { POST } from '@/app/api/cowork/extensions/log/route';

function fakeReq(body: unknown): any {
  const payload = new TextEncoder().encode(JSON.stringify(body));
  return {
    nextUrl: { searchParams: new URLSearchParams('') },
    headers: new Headers(),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      },
    }),
  };
}

// One shared console.info spy for every test in this file; the existing
// `afterEach` (vi.restoreAllMocks) restores it, so no test has to repeat
// the spy setup (and a forgotten spy cannot pollute other tests).
let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  spy = vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/cowork/extensions/log', () => {
  it('returns 200 and emits a structured log line', async () => {
    const res = await POST(fakeReq({ source: 'SW', msg: 'hello' }));
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    const arg = spy.mock.calls[0][1] as { source: string; message: string; stack: string };
    expect(arg.source).toBe('SW');
    expect(arg.message).toBe('hello');
  });

  it('strips CRLF from attacker-controlled fields (log-line forgery defense)', async () => {
    const forged = 'benign\n[SW:EVIL] injected log line\r\nsecond';
    await POST(fakeReq({ source: 'SW', msg: forged }));
    const arg = spy.mock.calls[0][1] as { message: string };
    expect(arg.message).not.toContain('\n');
    expect(arg.message).not.toContain('\r');
    expect(arg.message).toBe('benign [SW:EVIL] injected log line  second');
  });

  it('caps oversized fields (length bound)', async () => {
    const huge = 'x'.repeat(10_000);
    await POST(fakeReq({ source: 'SW', msg: huge }));
    const arg = spy.mock.calls[0][1] as { message: string };
    expect(arg.message.length).toBeLessThanOrEqual(4096);
  });

  it('handles non-string fields without throwing', async () => {
    const res = await POST(fakeReq({ source: 123, msg: null, stack: { nested: true } }));
    expect(res.status).toBe(200);
    const arg = spy.mock.calls[0][1] as { source: string; message: string };
 // A non-string `source` sanitizes to '' and then falls back to 'SW' (`|| 'SW'`).
    expect(arg.source).toBe('SW');
    expect(arg.message).toBe('(no message)');
  });

  it('falls back to "SW" when source is omitted', async () => {
    const res = await POST(fakeReq({ msg: 'hi' }));
    expect(res.status).toBe(200);
    const arg = spy.mock.calls[0][1] as { source: string; message: string };
    expect(arg.source).toBe('SW');
    expect(arg.message).toBe('hi');
  });

  it('falls back to "(no message)" when msg is omitted', async () => {
    const res = await POST(fakeReq({ source: 'SW' }));
    expect(res.status).toBe(200);
    const arg = spy.mock.calls[0][1] as { source: string; message: string };
    expect(arg.source).toBe('SW');
    expect(arg.message).toBe('(no message)');
  });
});
