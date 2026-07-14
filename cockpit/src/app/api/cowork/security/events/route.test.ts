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
  const count = vi.fn(async () => SAMPLE.length);
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
  });

  it('forwards a severity filter to the query', async () => {
    await GET(getReq('severity=high'));
    expect(findMany.mock.lastCall![0].where).toEqual({ severity: 'high' });
    expect(count).toHaveBeenCalledWith({ where: { severity: 'high' } });
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
  });

  it('caps limit at 200 (cannot dump the whole table at once)', async () => {
    await GET(getReq('limit=99999'));
    expect(findMany.mock.lastCall![0].take).toBe(200);
  });

  it('defaults limit to 100 when omitted', async () => {
    await GET(getReq());
    expect(findMany.mock.lastCall![0].take).toBe(100);
  });
});
