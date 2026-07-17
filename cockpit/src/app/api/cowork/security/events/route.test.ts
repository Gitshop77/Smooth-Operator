/**
 * `security/events` route handler tests.
 *
 * GET lists persisted security events (Prisma-backed). We mock `@/lib/db` so no
 * real DB is needed, and assert:
 * - a well-formed request returns 200 with events projected onto the legacy
 * shape (`createdAt` → `timestamp`, `details` → `description`);
 * - a `severity` filter is forwarded to `db.securityEvent.findMany`;
 * - the `limit` query param is capped (defense against full-table dumps);
 * - auth is enforced by the middleware (covered in `auth-contract.test.ts`,
 * but asserted here too for completeness of this route's contract).
 */

import { describe, it, expect, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { findMany, count, SAMPLE } = vi.hoisted(() => {
  const SAMPLE = [
    {
      id: 1,
      severity: 'high',
      channel: 'security:event',
      details: 'suspicious navigation',
      payload: { foo: 1 },
      createdAt: new Date('2025-01-01T00:00:00Z'),
    },
  ];
  const findMany = vi.fn<(query: Record<string, unknown>) => Promise<typeof SAMPLE>>(async () => SAMPLE);
  const count = vi.fn<(query: Record<string, unknown>) => Promise<number>>(async () => SAMPLE.length);
  return { findMany, count, SAMPLE };
});

vi.mock('@/lib/db', () => ({
  db: {
    securityEvent: {
      findMany,
      count,
    },
  },
}));

import { GET } from '@/app/api/cowork/security/events/route';

function getReq(search = ''): NextRequest {
  return {
    nextUrl: { searchParams: new URLSearchParams(search) },
  } as NextRequest;
}

describe('GET /api/cowork/security/events', () => {
  it('returns 200 with projected events (timestamp + description)', async () => {
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.events).toHaveLength(1);
    const e = body.events[0];
    expect(e.timestamp).toBe('2025-01-01T00:00:00.000Z');
    expect(e.description).toBe('suspicious navigation');
 // The raw Prisma fields are still present (spread) + projected aliases.
    expect(e.severity).toBe('high');
 // AU-3: the raw `details` field must survive the projection round-trip.
    expect(e.details).toBe('suspicious navigation');
  });

  it('forwards a severity filter to the query', async () => {
    await GET(getReq('severity=high'));
    expect((findMany.mock.lastCall?.[0] ?? {}).where).toEqual({ severity: 'high' });
    expect(count).toHaveBeenCalledWith({ where: { severity: 'high' } });
 // count must share findMany's where so `total` matches the filtered page.
    expect((count.mock.lastCall?.[0] ?? {}).where).toEqual((findMany.mock.lastCall?.[0] ?? {}).where);
  });

  it('runs count with the same empty where as findMany on the unfiltered path', async () => {
    await GET(getReq());
    expect(count).toHaveBeenCalledWith({ where: {} });
    expect((count.mock.lastCall?.[0] ?? {}).where).toEqual((findMany.mock.lastCall?.[0] ?? {}).where);
  });

  it('rejects an invalid severity with 400', async () => {
    const res = await GET(getReq('severity=boom'));
    expect(res.status).toBe(400);
  });

  it('falls back to an empty description when details is null', async () => {
    findMany.mockResolvedValueOnce([{ ...SAMPLE[0], id: 2, details: null }] as unknown as typeof SAMPLE);
    const res = await GET(getReq());
    const e = (await res.json()).events[0];
    expect(e.description).toBe('');
 // AU-3: null `details` round-trips as null while `description` falls back to ''.
    expect(e.details).toBeNull();
  });

  it('caps limit at 200 (cannot dump the whole table at once)', async () => {
    await GET(getReq('limit=99999'));
    expect((findMany.mock.lastCall?.[0] ?? {}).take).toBe(200);
  });

  it('defaults limit to 100 when omitted', async () => {
    await GET(getReq());
    expect((findMany.mock.lastCall?.[0] ?? {}).take).toBe(100);
  });

  it('clamps an over-large offset to 10000', async () => {
    await GET(getReq('offset=999999999'));
    expect((findMany.mock.lastCall?.[0] ?? {}).skip).toBe(10_000);
  });

  it('falls back to skip 0 for a non-numeric offset', async () => {
    await GET(getReq('offset=abc'));
    expect((findMany.mock.lastCall?.[0] ?? {}).skip).toBe(0);
  });

  it('preserves the payload field in the projected response', async () => {
    const res = await GET(getReq());
    const body = await res.json();
    expect(body.events[0].payload).toEqual({ foo: 1 });
  });

  it('redacts secrets in details and sourceUrl on read', async () => {
    findMany.mockResolvedValueOnce([
      {
        ...SAMPLE[0],
        id: 3,
        details: 'Bearer eyJabc.def.ghi',
        sourceUrl: 'https://example.com/cb?token=supersecretvalue123',
        domain: 'example.com',
      } as unknown as typeof SAMPLE[0],
    ]);
    const res = await GET(getReq());
    const e = (await res.json()).events[0];
    // details/description must not contain the raw bearer token.
    expect(JSON.stringify(e.description)).not.toContain('eyJabc');
    expect(JSON.stringify(e.details)).not.toContain('eyJabc');
    // sourceUrl/domain secrets must be redacted.
    expect(e.sourceUrl).toContain('***');
    expect(e.sourceUrl).not.toContain('supersecretvalue123');
    expect(e.domain).toBe('example.com');
  });
});
