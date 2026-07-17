import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ClientError, withRouteError, bodyJson, bodyJsonOptional, isSsrfSafeUrl,
  redactSecrets, parseLimit, parseAgentId, sanitizeRequestId, boundedString,
  validateHttpUrl, readCappedUpstream, tokenPrincipal,
} from '@/lib/cowork/api/http';
import { POST as tabsPost } from '@/app/api/cowork/tabs/route';
import { POST as bookmarksPost } from '@/app/api/cowork/bookmarks/route';
import { POST as workflowsPost } from '@/app/api/cowork/workflows/route';
import { POST as sessionsPost } from '@/app/api/cowork/sessions/route';

// Mock Prisma so route handlers can be exercised without a live DB.
const created: any[] = [];

// Reset the shared `created` array between tests so assertions that rely on
// value uniqueness (e.g. a 512-char userAgent) cannot match a record inserted
// by an earlier test.
beforeEach(() => {
  created.length = 0;
});

// `vi.mock` factories are hoisted above all other module-level statements, so a
// factory that closes over a `const bookmarkFakes` declared below would hit a
// TDZ. Lift the shared `bookmark` fakes with `vi.hoisted` so they exist before
// the factory runs, and so the top-level `db.bookmark` and the `$transaction`
// callback's `tx.bookmark` share the exact same mock instances.
const { bookmarkFakes } = vi.hoisted(() => ({
  bookmarkFakes: {
    create: vi.fn(async (a: any) => { created.push(a.data); return a.data; }),
    findMany: vi.fn(async () => []),
    findUnique: vi.fn(async () => null),
  },
}));

vi.mock('@/lib/db', () => ({
  db: {
    tab: {
      create: vi.fn(async (a: any) => { created.push(a.data); return a.data; }),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    workspace: { findUnique: vi.fn(async () => ({ id: 'ws1', name: 'ws' })) },
    bookmark: bookmarkFakes,
    workflow: {
      create: vi.fn(async (a: any) => { created.push(a.data); return a.data; }),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    session: {
      create: vi.fn(async (a: any) => { created.push(a.data); return a.data; }),
      findMany: vi.fn(async () => []),
    },
 // The bookmarks route wraps create/lookup in `db.$transaction`, which the
 // previous mock omitted — so the handler threw "db.$transaction is not a
 // function" and every affected test got a 500 instead of 201/400. Run the
 // callback with a `tx` that carries the same `bookmark` fakes so the in-tx
 // `findUnique`/`create` resolve. A callback that returns `null` (unknown
 // parentId) is propagated unchanged so the route can map it to a 400.
    $transaction: vi.fn(async (fn: (tx: any) => Promise<any>) => fn({ bookmark: bookmarkFakes })),
  },
}));

// Build a real ReadableStream body so `bodyJson` -> `readCappedBody`
// (which calls `req.body.getReader()`) can actually consume it. The previous
// fakes passed a plain object with a `text()` method, which `readCappedBody`
// never calls — so every test that hit `bodyJson` threw and the whole suite
// was non-executable.
function streamFromString(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

// A minimal request for the low-level body helpers. `text === null` models an
// absent body (`req.body` falsy); otherwise the body is a real stream carrying
// exactly that text.
function fakeReq(text: string | null): any {
  return { body: text === null ? null : streamFromString(text) };
}

// A POST-style NextRequest: a real stream body plus the `headers.get` and
// `nextUrl.searchParams` accessors the route handlers touch (tabs/bookmarks read
// `req.headers.get('x-request-id')`).
function fakePostReq(body: Record<string, unknown>): any {
  return {
    body: streamFromString(JSON.stringify(body)),
    headers: { get: () => null },
    nextUrl: { searchParams: new URLSearchParams() },
  };
}

// A minimal NextRequest carrying only `nextUrl.searchParams` (for parseLimit /
// parseAgentId, which never read the body).
function fakeNextReq(search: string): any {
  return { nextUrl: { searchParams: new URLSearchParams(search) } };
}

describe('bodyJson (F-04b)', () => {
  it('returns {} when there is no body', async () => {
    const result = await bodyJson(fakeReq(null));
    expect(result).toEqual({});
  });

  it('returns {} when the body text is empty', async () => {
    const result = await bodyJson(fakeReq(''));
    expect(result).toEqual({});
  });

  it('parses valid JSON', async () => {
    const result = await bodyJson(fakeReq('{"a":1,"b":"x"}'));
    expect(result).toEqual({ a: 1, b: 'x' });
  });

  it('THROWS on malformed (non-empty) JSON instead of returning {}', async () => {
    await expect(bodyJson(fakeReq('{bad json'))).rejects.toThrow();
  });
});

describe('bodyJsonOptional (F-04b tolerant variant)', () => {
  it('returns {} for an absent body', async () => {
    expect(await bodyJsonOptional(fakeReq(null))).toEqual({});
  });

  it('returns {} for an empty body', async () => {
    expect(await bodyJsonOptional(fakeReq(''))).toEqual({});
  });

  it('parses valid JSON', async () => {
    expect(await bodyJsonOptional(fakeReq('{"x":1}'))).toEqual({ x: 1 });
  });

  it('NEVER throws on malformed JSON — a malformed body surfaces as a ClientError (400) via bodyJson, but a plain read error is swallowed to {}', async () => {
 // `bodyJsonOptional` re-throws `ClientError` (so the 400 / 413 contract is
 // preserved), and only swallows genuine non-ClientError read failures.
    await expect(bodyJsonOptional(fakeReq('{bad json'))).rejects.toBeInstanceOf(ClientError);
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

  it('echoes only app-authored ClientError messages verbatim (with their status)', async () => {
    const res = await withRouteError(async () => {
      throw new ClientError('url is required', 400);
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('url is required');
    expect(typeof body.correlationId).toBe('string');
  });

  it('does NOT substring-sniff a plain Error — a validation-sounding message is still withheld as internal_error/500', async () => {
    const res = await withRouteError(async () => {
      throw new Error('url is required');
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('internal_error');
  });

  it('turns a malformed-body throw into a 400 with the safe message', async () => {
    const res = await withRouteError(async () => {
      const b = await bodyJson(fakeReq('{bad'));
      return new Response(JSON.stringify(b));
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid JSON body');
  });

  it('redacts secret-bearing URL credentials in the logged internal-error message', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await withRouteError(async () => {
        throw new Error('db error postgres://user:pass@host');
      });
      const logged = spy.mock.calls.map((c) => c.join(' ')).join(' ');
      expect(logged).not.toContain('pass@host');
      expect(logged).toContain('***@host');
    } finally {
      spy.mockRestore();
    }
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
 // Invalid IPv6 literal — caught by the URL-parse catch path (negative case).
 // `[:1]` should NOT be used as a proxy for valid IPv6: it never exercises the
 // real bracketed-IPv6 handling, so do not rely on it to cover that path.
    expect(isSsrfSafeUrl('http://[:1]/')).toBe(false);
 // Valid IPv6 literals that exercise the real bracketed-IPv6 handling below.
    expect(isSsrfSafeUrl('http://[::1]/')).toBe(false);
    expect(isSsrfSafeUrl('http://[fe80::1]/')).toBe(false);
    expect(isSsrfSafeUrl('http://[::]/')).toBe(false);
    expect(isSsrfSafeUrl('http://[::ffff:ac10:0000]/')).toBe(false);
    expect(isSsrfSafeUrl('http://[::ffff:c0a8:0001]/')).toBe(false);
    expect(isSsrfSafeUrl('http://[::ffff:127.0.0.1]/')).toBe(false);
 // Fully-expanded IPv4-mapped IPv6 literals (8-hextet form) must also be
 // blocked — `0:0:0:0:0:ffff:a9fe:a9fe` === ::ffff:169.254.169.254 (cloud
 // metadata) and `0:0:0:0:0:ffff:7f00:1` === ::ffff:127.0.0.1 (loopback).
    expect(isSsrfSafeUrl('http://[0:0:0:0:0:ffff:a9fe:a9fe]/')).toBe(false);
    expect(isSsrfSafeUrl('http://[0:0:0:0:0:ffff:7f00:1]/')).toBe(false);
   // NAT64 well-known prefix (64:ff9b::/96) embeds a 32-bit IPv4 in the low
   // 32 bits — 64:ff9b::a9fe:a9fe == 169.254.169.254 (cloud metadata) and
   // 64:ff9b::7f00:1 == 127.0.0.1 (loopback). A NAT64 gateway resolves these
   // to the embedded private/metadata address, so they must be blocked too.
    expect(isSsrfSafeUrl('http://[64:ff9b::a9fe:a9fe]/')).toBe(false);
    expect(isSsrfSafeUrl('http://[64:ff9b::7f00:1]/')).toBe(false);
    expect(isSsrfSafeUrl('http://[64:ff9b::169.254.169.254]/')).toBe(false);
 // Encoded-IPv4 and trailing-dot bypass forms the guard exists to defeat.
    expect(isSsrfSafeUrl('http://2130706433/')).toBe(false); // decimal loopback
    expect(isSsrfSafeUrl('http://0177.0.0.1/')).toBe(false); // octal
    expect(isSsrfSafeUrl('http://0x7f.0.0.1/')).toBe(false); // hex
    expect(isSsrfSafeUrl('http://localhost./')).toBe(false); // trailing-dot loopback
   // CGNAT range (100.64.0.0/10) — cloud-provider CGNAT addresses; a refactor
   // that drops this range would open an SSRF path.
    expect(isSsrfSafeUrl('http://100.64.0.1/')).toBe(false);
    expect(isSsrfSafeUrl('http://100.64.127.255/')).toBe(false);
   // inet_aton shorthand (127.1 -> 127.0.0.1) must still resolve and be blocked.
    expect(isSsrfSafeUrl('http://127.1/')).toBe(false);
   // IPv6 zone-id form (`fe80::1%eth0`) — a zone-scoped link-local address is
   // still link-local. It must be rejected (isRestrictedHost rejects any `%` in
   // the host). Pin both the bare and percent-encoded forms so a refactor that
   // classifies the host before stripping the zone-id cannot reopen it.
    expect(isSsrfSafeUrl('http://[fe80::1%eth0]/')).toBe(false);
    expect(isSsrfSafeUrl('http://[fe80::1%25eth0]/')).toBe(false);
  });

  it('rejects single-label / private-mDNS-TLD hosts', () => {
    expect(isSsrfSafeUrl('http://intranet/')).toBe(false);
    expect(isSsrfSafeUrl('http://printer.local/')).toBe(false);
    expect(isSsrfSafeUrl('http://app.internal/')).toBe(false);
    expect(isSsrfSafeUrl('http://nas.lan/')).toBe(false);
    expect(isSsrfSafeUrl('http://router.home/')).toBe(false);
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

describe('validateHttpUrl', () => {
  it('returns null for http/https URLs', () => {
    expect(validateHttpUrl('http://example.com')).toBeNull();
    expect(validateHttpUrl('https://example.com')).toBeNull();
  });

  it('returns a 400 Response for non-http(s) schemes', async () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd']) {
      const res = validateHttpUrl(url);
      expect(res).toBeInstanceOf(Response);
      expect((res as Response).status).toBe(400);
    }
  });

  it('returns a 400 Response for a non-URL string', () => {
    const res = validateHttpUrl('not a url');
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(400);
  });

  it('rejects case-varied dangerous schemes (scheme-insensitive)', async () => {
 // The WHATWG URL parser lowercases the scheme, so an upper/mixed-case
 // `JAVASCRIPT:` / `DATA:` must be rejected exactly like the lowercase form.
 // Locks scheme-insensitive rejection against a naive case-sensitive refactor
 // that would let these be persisted and later opened as executable script.
    for (const url of ['JAVASCRIPT:alert(1)', 'DATA:text/html,<script>']) {
      const res = validateHttpUrl(url);
      expect(res).toBeInstanceOf(Response);
      expect((res as Response).status).toBe(400);
    }
  });
});

// ---------------------------------------------------------------------------
// Storage-route URL contract (tabs / bookmarks).
//
// IMPORTANT: the *tabs* storage route deliberately does NOT apply
// `isSsrfSafeUrl` — stored URLs are opened client-side in the browser, never
// fetched server-side, so a developer's `http://localhost:3000` bookmark must
// stay valid and cloud metadata / loopback / RFC1918 hosts are ACCEPTED at
// storage time. The *bookmarks* route, by contrast, DOES apply `isSsrfSafeUrl`
// at storage time and rejects those same hosts with 400. What both routes
// enforce is the *scheme* (http/https only) via `validateHttpUrl`, which blocks
// `javascript:` / `data:` stored-XSS. These tests drive the real route handlers
// (db mocked) and pin that contract — tabs stays scheme-only, bookmarks is
// SSRF-gated.
// ---------------------------------------------------------------------------
describe('stored-URL scheme boundary — tabs route', () => {
  it('accepts http://169.254.169.254 (cloud metadata) with 201 — storage is scheme-only, not SSRF-gated', async () => {
    const res = await tabsPost(fakePostReq({ url: 'http://169.254.169.254/latest/meta-data/', workspaceId: 'ws1' }));
    expect(res.status).toBe(201);
  });

  it('accepts http://localhost (loopback) with 201 — developer bookmarks must stay valid', async () => {
    const res = await tabsPost(fakePostReq({ url: 'http://localhost/', workspaceId: 'ws1' }));
    expect(res.status).toBe(201);
  });

  it('accepts https://example.com with 201', async () => {
    const res = await tabsPost(fakePostReq({ url: 'https://example.com/', workspaceId: 'ws1' }));
    expect(res.status).toBe(201);
  });

  it('rejects a non-http(s) scheme (javascript:) with 400', async () => {
    const res = await tabsPost(fakePostReq({ url: 'javascript:alert(1)', workspaceId: 'ws1' }));
    expect(res.status).toBe(400);
  });
});

describe('stored-URL scheme boundary — bookmarks route', () => {
  it('rejects http://169.254.169.254 (cloud metadata) with 400 — SSRF-gated at storage', async () => {
    const res = await bookmarksPost(fakePostReq({ name: 'x', url: 'http://169.254.169.254/latest/meta-data/', type: 'url' }));
    expect(res.status).toBe(400);
  });

  it('accepts https://example.com with 201', async () => {
    const res = await bookmarksPost(fakePostReq({ name: 'x', url: 'https://example.com/', type: 'url' }));
    expect(res.status).toBe(201);
  });

  it('rejects a non-http(s) scheme (data:) with 400', async () => {
    const res = await bookmarksPost(fakePostReq({ name: 'x', url: 'data:text/html,<script>1</script>', type: 'url' }));
    expect(res.status).toBe(400);
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

// ---------------------------------------------------------------------------
// Secret-redaction guard (redactSecrets) — on every server-side error log.
// ---------------------------------------------------------------------------
describe('redactSecrets', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('redacts credentials embedded in URLs', () => {
    expect(redactSecrets('http://user:pass@example.com/path')).toBe('http://***@example.com/path');
  });

  it('redacts credentials in non-http DB connection-string URLs', () => {
    expect(redactSecrets('postgres://user:pass@host:5432/db')).toBe('postgres://***@host:5432/db');
    expect(redactSecrets('mysql://u:p@db/prod')).toBe('mysql://***@db/prod');
    expect(redactSecrets('mongodb://u:p@cluster.local')).toBe('mongodb://***@cluster.local');
    expect(redactSecrets('redis://u:p@cache:6379')).toBe('redis://***@cache:6379');
    expect(redactSecrets('amqp://u:p@broker')).toBe('amqp://***@broker');
  });

  it('redacts Bearer tokens', () => {
    expect(redactSecrets('Bearer abcd1234')).toBe('Bearer ***');
  });

  it('redacts HTTP Basic credentials', () => {
    expect(redactSecrets('Authorization: Basic dXNlcjpwA==')).toBe('Authorization: Basic ***');
  });

  it('redacts JSON-shaped secrets', () => {
    expect(redactSecrets('"api_key": "xyz"')).toBe('"api_key":"***"');
  });

  it('redacts secret-bearing key=value pairs', () => {
    expect(redactSecrets('token=secret')).toBe('token=***');
  });

  it('redacts the configured COWORK_UI_TOKEN value', () => {
    vi.stubEnv('COWORK_UI_TOKEN', 'ui-super-secret');
    expect(redactSecrets('saw ui-super-secret in logs')).toBe('saw *** in logs');
  });

  it('does not redact the dev-token literal', () => {
    vi.stubEnv('COWORK_UI_TOKEN', 'dev-token');
    expect(redactSecrets('dev-token should remain')).toBe('dev-token should remain');
  });

  it('redacts the configured COWORK_EVENT_TOKEN value', () => {
    vi.stubEnv('COWORK_EVENT_TOKEN', 'evt-super-secret');
    expect(redactSecrets('saw evt-super-secret in logs')).toBe('saw *** in logs');
  });

  it('redacts standalone provider credential literals (sk-ant / sk- / AIza / JWT)', () => {
    expect(redactSecrets('saw sk-ant-abc123def456ghi789jkl in trace')).toBe('saw *** in trace');
    expect(redactSecrets('key sk-abc123def456ghi789jklmno done')).toBe('key *** done');
    expect(redactSecrets('AIza' + 'a'.repeat(35) + ' x')).toBe('*** x');
    expect(redactSecrets('jwt eyJhbGciOi.eyJzdWIi.SflKxwRJ here')).toBe('jwt *** here');
  });

  it('redacts additional provider credential literals (gsk- / xox* / AKIA)', () => {
    expect(redactSecrets('groq gsk-abc123DEF456ghiJKL789 done')).toBe('groq *** done');
    expect(redactSecrets('slack xoxb-1234567890-abcdefghij done')).toBe('slack *** done');
    expect(redactSecrets('aws AKIAIOSFODNN7EXAMPLE leaked')).toBe('aws *** leaked');
  });

  it('redacts a 20+ char bare high-entropy scalar via the entropy fallback', () => {
    expect(redactSecrets('leaked Tr0ub4dorABCDEF1234567890 here')).toBe('leaked *** here');
  });

  it('leaves short words and already-redacted markers intact via the entropy fallback', () => {
    expect(redactSecrets('hello world short ok')).toBe('hello world short ok');
    expect(redactSecrets('value *** placeholder')).toBe('value *** placeholder');
  });
});

// ---------------------------------------------------------------------------
// Input-boundary guards (log-injection / bounds / bounds sanity).
// ---------------------------------------------------------------------------
describe('parseLimit', () => {
  it('clamps an over-max value to the max', () => {
    expect(parseLimit(fakeNextReq('limit=9999'), 100, 200)).toBe(200);
  });

  it('returns 1 for a negative value (floor, never below 1)', () => {
    expect(parseLimit(fakeNextReq('limit=-5'), 100, 200)).toBe(1);
  });

  it('falls back to the default for a zero value', () => {
    expect(parseLimit(fakeNextReq('limit=0'), 100, 200)).toBe(100);
  });

  it('returns the default when the param is absent', () => {
    expect(parseLimit(fakeNextReq(''), 100, 200)).toBe(100);
  });
});

describe('parseAgentId', () => {
  it('returns undefined for an empty param', () => {
    expect(parseAgentId(fakeNextReq('agentId='))).toBeUndefined();
  });

  it('returns the value for a valid agentId', () => {
    expect(parseAgentId(fakeNextReq('agentId=abc-123'))).toBe('abc-123');
  });

  it('throws on a too-long agentId (>128 chars)', () => {
    expect(() => parseAgentId(fakeNextReq('agentId=' + 'a'.repeat(129)))).toThrow(ClientError);
  });

  it('throws on an agentId containing a control character', () => {
    expect(() => parseAgentId(fakeNextReq('agentId=a\x01b'))).toThrow(ClientError);
  });
});

describe('sanitizeRequestId', () => {
  it('accepts a printable ASCII correlation id', () => {
    expect(sanitizeRequestId('req-1234-ABCD')).toBe('req-1234-ABCD');
  });

  it('rejects a value containing a control/CRLF character', () => {
    expect(sanitizeRequestId('bad\nid')).toBeUndefined();
  });

  it('rejects a value longer than 64 chars', () => {
    expect(sanitizeRequestId('a'.repeat(65))).toBeUndefined();
  });
});

describe('boundedString', () => {
  it('throws a ClientError on non-string input', () => {
    expect(() => boundedString(123 as unknown, 64)).toThrow(ClientError);
  });

  it('truncates a string to maxLen', () => {
    expect(boundedString('hello', 3)).toBe('hel');
  });

  it('returns the fallback capped for null/undefined', () => {
    expect(boundedString(undefined, 64, 'fall')).toBe('fall');
  });
});

// ---------------------------------------------------------------------------
// Memory-exhaustion cap on inbound request bodies (readCappedBody via bodyJson).
// A single oversized body must be rejected with 413 BEFORE it is buffered, so a
// caller holding the X-Cowork-Token cannot exhaust server memory.
// ---------------------------------------------------------------------------
describe('bodyJson oversize-body cap', () => {
  it('rejects a body larger than 256 KiB with 413 before buffering', async () => {
    const big = 'x'.repeat(256 * 1024 + 1);
    let err: unknown;
    try {
      await bodyJson(fakeReq(big));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ClientError);
    expect((err as ClientError).status).toBe(413);
  });

  it('accepts a body just under the 256 KiB cap', async () => {
    const ok = 'x'.repeat(256 * 1024 - 1000);
    const result = await bodyJson(fakeReq(JSON.stringify({ v: ok })));
    expect(typeof result).toBe('object');
    expect((result as { v?: string }).v).toBe(ok);
  });
});

// ---------------------------------------------------------------------------
// Memory-exhaustion cap on OUTBOUND upstream (mini-service) responses
// (readCappedUpstream). An over-cap proxied response must be rejected with 502
// before it is buffered, and an within-cap response must stream through.
// ---------------------------------------------------------------------------
describe('readCappedUpstream over-cap guard', () => {
  it('returns text for a response within the cap', async () => {
    const res = new Response(streamFromString('hello world'));
    const text = await readCappedUpstream(res, 100);
    expect(text).toBe('hello world');
  });

  it('rejects a response larger than the cap with 502', async () => {
    const res = new Response(streamFromString('y'.repeat(200)));
    let err: unknown;
    try {
      await readCappedUpstream(res, 100);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ClientError);
    expect((err as ClientError).status).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// tokenPrincipal (AU-3): a non-secret, stable audit principal derived from a
// token. It must be deterministic, prefixed, and must NEVER embed the raw
// token so leaked logs cannot recover the credential.
// ---------------------------------------------------------------------------
describe('tokenPrincipal (AU-3)', () => {
  it('is deterministic and stable across calls for the same token', () => {
    const a = tokenPrincipal('some-secret-token');
    const b = tokenPrincipal('some-secret-token');
    expect(a).toBe(b);
    expect(a.startsWith('tok_')).toBe(true);
  });

  it('does not contain the raw token in the derived principal', () => {
    const p = tokenPrincipal('my-raw-secret-token-value');
    expect(p).not.toContain('my-raw-secret-token-value');
    expect(p.startsWith('tok_')).toBe(true);
  });
});
