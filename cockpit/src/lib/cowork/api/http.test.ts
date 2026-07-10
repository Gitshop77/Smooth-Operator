import { describe, it, expect } from 'vitest';
import { withRouteError, bodyJson, bodyJsonOptional, isSsrfSafeUrl } from '@/lib/cowork/api/http';

// Minimal fake of the bits of NextRequest that bodyJson touches.
function fakeReq(body: unknown, text: string): any {
  return { body, text: async () => text };
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

describe('isSsrfSafeUrl (F-17)', () => {
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
