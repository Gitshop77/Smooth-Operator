// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { json, withRouteError, parseLimit, badRequest } from '@/lib/cowork/api/http';
import { db } from '@/lib/db';

// Mirrors the closed `severity` enum documented on the `SecurityEvent` model
// in prisma/schema.prisma. SQLite has no native enum, so the contract is
// enforced here at the API boundary.
const ALLOWED_SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;

export async function GET(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
 // Cap `limit` to a hard max of 200 so a hostile or buggy
 // caller can't ask for the entire table in one shot. Default 100.
    const limit = parseLimit(req);
 // Optional `offset` for paging older events beyond the first `limit` rows.
    const offset = Math.max(0, parseInt(req.nextUrl.searchParams.get('offset') || '0', 10) || 0);
    const severityParam = req.nextUrl.searchParams.get('severity');
 // Reject junk `severity` values with 400 instead of silently returning an
 // empty set. Prisma parameterizes the input (not an injection risk), but an
 // unvalidated string yields a confusing empty result for non-matching input.
    if (severityParam !== null && !(ALLOWED_SEVERITIES as readonly string[]).includes(severityParam)) {
      return badRequest(
        `Invalid severity "${severityParam}"; allowed values: ${ALLOWED_SEVERITIES.join(', ')}`,
      );
    }
    const severity = severityParam ?? undefined;
    const where = severity ? { severity } : {};
 // Run the independent findMany + count concurrently in a single round-trip.
    const [events, count] = await Promise.all([
      db.securityEvent.findMany({ where, take: limit, skip: offset, orderBy: { createdAt: 'desc' } }),
      db.securityEvent.count({ where }),
    ]);
 // Project the Prisma `SecurityEvent` fields onto the legacy
 // `SampleSecurityEvent` shape the view expects: `createdAt` →
 // `timestamp` and `details` → `description`.
    const projected = events.map((e) => ({
      ...e,
      timestamp: e.createdAt,
      description: e.details ?? '',
    }));
    return json({ events: projected, total: count });
  });
}
