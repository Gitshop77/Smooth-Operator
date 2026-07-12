// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { json, withRouteError, parseLimit, badRequest } from '@/lib/cowork/api/http';
import { db } from '@/lib/db';

// Mirrors the closed `severity` enum documented on the `SecurityEvent` model
// in prisma/schema.prisma. SQLite has no native enum, so the contract is
// enforced here at the API boundary.
const ALLOWED_SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
type Severity = (typeof ALLOWED_SEVERITIES)[number];

export async function GET(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
 // Cap `limit` to a hard max of 200 so a hostile or buggy
 // caller can't ask for the entire table in one shot. Default 100.
    const limit = parseLimit(req);
    const severityParam = req.nextUrl.searchParams.get('severity');
 // Reject junk `severity` values with 400 instead of silently returning an
 // empty set. Prisma parameterizes the input (not an injection risk), but an
 // unvalidated string yields a confusing empty result for non-matching input.
    if (severityParam !== null && !ALLOWED_SEVERITIES.includes(severityParam as Severity)) {
      return badRequest(
        `Invalid severity "${severityParam}"; allowed values: ${ALLOWED_SEVERITIES.join(', ')}`,
      );
    }
    const severity = severityParam ?? undefined;
    const events = severity
      ? await db.securityEvent.findMany({ where: { severity }, take: limit, orderBy: { createdAt: 'desc' } })
      : await db.securityEvent.findMany({ take: limit, orderBy: { createdAt: 'desc' } });
    const count = await db.securityEvent.count({ where: severity ? { severity } : {} });
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
