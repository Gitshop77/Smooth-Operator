// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { json, withRouteError, parseLimit, badRequest } from '@/lib/cowork/api/http';
import { db } from '@/lib/db';

export async function GET(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
 // Cap `limit` to a hard max (parseLimit default 100, max 200) so a single
 // authenticated GET can't pull the entire extensions table in one shot.
    const limit = parseLimit(req);
    const enabled = req.nextUrl.searchParams.get('enabled');
 // Validate `enabled` against an explicit allowlist. Previously any non-null,
 // non-'true' value (e.g. `?enabled=1`, `?enabled=TRUE`, `?enabled=yes`)
 // made `enabled === 'true'` evaluate to `false`, silently filtering to
 // *disabled-only* extensions with no error. Non-canonical values now get a
 // 400. An absent param means "no filter".
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
