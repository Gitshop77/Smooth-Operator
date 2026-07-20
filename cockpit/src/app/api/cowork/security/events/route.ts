// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { json, withRouteError, parseLimit, badRequest, redactSecrets, sanitizeRequestId } from '@/lib/cowork/api/http';
import { db } from '@/lib/db';

// Mirrors the closed `severity` enum documented on the `SecurityEvent` model
// in prisma/schema.prisma. SQLite has no native enum, so the contract is
// enforced here at the API boundary.
const ALLOWED_SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;

// Mask secret shapes in an arbitrary stored value before returning it to the
// reader (defense-in-depth, mirroring extensions/log). Re-parsing is safe:
// redactSecrets only replaces secret substrings inside string contents and
// never alters JSON structure.
function redactValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  try {
    return JSON.parse(redactSecrets(JSON.stringify(v)));
  } catch {
    return v;
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
 // Cap `limit` to a hard max of 200 so a hostile or buggy
 // caller can't ask for the entire table in one shot. Default 100.
    const limit = parseLimit(req);
 // Optional `offset` for paging older events beyond the first `limit` rows.
// Clamp it to a sane maximum so a caller can't force a huge `skip` (range
// traversal amplification) on Prisma/SQLite, mirroring the `limit` cap above.
    const MAX_OFFSET = 10_000;
    const offset = Math.min(MAX_OFFSET, Math.max(0, parseInt(req.nextUrl.searchParams.get('offset') || '0', 10) || 0));
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
      details: redactValue(e.details),
      timestamp: e.createdAt,
      description: redactValue(e.details),
      sourceUrl: e.sourceUrl ? redactSecrets(e.sourceUrl) : e.sourceUrl,
      domain: e.domain ? redactSecrets(e.domain) : e.domain,
    }));
    return json({ events: projected, total: count });
  }, sanitizeRequestId(req.headers?.get('x-request-id') ?? null));
}
