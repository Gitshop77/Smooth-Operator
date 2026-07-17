import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { POST, GET } from '@/app/api/cowork/extensions/log/route';

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

  it('redacts secret-shaped strings before emitting (secret-leak defense)', async () => {
    const secret =
      'login password=supersecret123 with Bearer eyJabc.def.ghi and sk-ant-ABCD1234567890EFGHIJKLMN';
    await POST(fakeReq({ source: 'SW', msg: secret }));
    const arg = spy.mock.calls[0][1] as { message: string };
    expect(arg.message).toContain('***');
    expect(arg.message).not.toContain('password=supersecret123');
    expect(arg.message).not.toContain('Bearer eyJabc');
    expect(arg.message).not.toContain('sk-ant-ABCD1234567890EFGHIJKLMN');
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

describe('GET /api/cowork/extensions/log (read-time redaction)', () => {
  it('re-applies redaction to stored entries before returning them', async () => {
    const secret = 'Bearer eyJabc.def.ghi token sk-ant-SECRET0123456789ABCDEF';
    await POST(fakeReq({ source: 'SW', msg: secret }));
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.logs)).toBe(true);
    expect(body.logs.length).toBeGreaterThan(0);
    const last = body.logs[body.logs.length - 1];
    expect(last.message).toContain('***');
    expect(last.message).not.toContain('sk-ant-SECRET0123456789ABCDEF');
    expect(last.message).not.toContain('eyJabc');
  });
});
