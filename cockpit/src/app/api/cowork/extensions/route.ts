// Wired to Prisma persistence layer.
import { timingSafeEqual } from 'node:crypto';
import type { NextRequest, NextResponse } from 'next/server';
import { json, withRouteError, parseLimit, badRequest } from '@/lib/cowork/api/http';
import { db } from '@/lib/db';

const DEV_TOKEN = 'dev-token';

/** Constant-time string compare (avoids timing oracles on the token). */
function tokensMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Require a valid `X-Cowork-Token` header (mirrors the token resolution in
 * `proxy.ts`). Zero-config (no real `COWORK_UI_TOKEN`) honors the well-known
 * `dev-token` so localhost works with no env; once a real UI token is set the
 * dev-token is rejected. Returns `null` when authorized, or a 401 Response.
 */
function requireCoworkToken(req: NextRequest): NextResponse | null {
  const uiToken =
    process.env.COWORK_UI_TOKEN && process.env.COWORK_UI_TOKEN.length > 0
      ? process.env.COWORK_UI_TOKEN
      : undefined;
  const eventToken =
    process.env.COWORK_EVENT_TOKEN && process.env.COWORK_EVENT_TOKEN.length > 0
      ? process.env.COWORK_EVENT_TOKEN
      : undefined;
  const zeroConfig = !uiToken;
  const token = uiToken ?? eventToken ?? DEV_TOKEN;
  const received = req.headers.get('x-cowork-token') ?? undefined;
  if (!received || (token === DEV_TOKEN && !zeroConfig)) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'Cache-Control': 'no-store', 'WWW-Authenticate': 'Bearer realm="cowork"' } },
    );
  }
  if (!tokensMatch(received, token)) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'Cache-Control': 'no-store', 'WWW-Authenticate': 'Bearer realm="cowork"' } },
    );
  }
  return null;
}

export async function GET(req: NextRequest): Promise<Response> {
  const authErr = requireCoworkToken(req);
  if (authErr) return authErr;
  return withRouteError(async () => {
 // Cap `limit` to a hard max (parseLimit default 100, max 200) so a single
 // authenticated GET can't pull the entire extensions table in one shot.
    const limit = parseLimit(req);
    const enabled = req.nextUrl.searchParams.get('enabled');
 // Validate `enabled` against an explicit allowlist: only 'true'/'false' are
 // accepted, any other value gets a 400. An absent param means "no filter".
    let enabledFilter: boolean | undefined;
    if (enabled !== null) {
      if (enabled !== 'true' && enabled !== 'false') {
        return badRequest(`Invalid enabled "${enabled}"; allowed values: true, false`);
      }
      enabledFilter = enabled === 'true';
    }
 // Build the `where` conditionally and issue a single deterministic query.
 // `findMany` treats `where: undefined` as "no filter", so the absent-param
 // path is preserved exactly; `orderBy: { createdAt: 'desc' }` gives a
 // stable per-request order (Postgres would otherwise return unspecified order).
    const where = enabledFilter !== undefined ? { isEnabled: enabledFilter } : undefined;
    const extensions = await db.extension.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
 // Project the Prisma `Extension` rows onto the `SampleExtension` shape the
 // view consumes. We map fields explicitly (no `...ext` spread) so the
 // response carries each field exactly once. The previous version spread
 // every Prisma column AND added `enabled`/`installedAt` aliases that
 // duplicated `isEnabled`/`createdAt`, plus a hardcoded `size: 0` that
 // falsely implied a real measurement. The Prisma `Extension` model has no
 // `size` column; the view already falls back to `0` via `ext.size ?? 0`
 // when the field is absent, so the alias is intentionally omitted.
    const projected = extensions.map((ext) => ({
      id: ext.id,
      name: ext.name,
      version: ext.version,
      description: ext.description,
      manifestJson: ext.manifestJson,
      isInstalled: ext.isInstalled,
      isEnabled: ext.isEnabled,
      source: ext.source,
      trustLevel: ext.trustLevel,
      createdAt: ext.createdAt,
      updatedAt: ext.updatedAt,
    }));
    return json({ extensions: projected });
  });
}
