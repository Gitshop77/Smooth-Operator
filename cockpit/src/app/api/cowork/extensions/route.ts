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
    const extensions =
      enabledFilter !== undefined
        ? await db.extension.findMany({ where: { isEnabled: enabledFilter }, take: limit })
        : await db.extension.findMany({ take: limit });
    // Project the Prisma `Extension` fields onto the legacy
    // `SampleExtension` shape the view expects: `isEnabled` → `enabled`,
    // `createdAt` → `installedAt`, and synthesize `size` (no column).
    const projected = extensions.map((ext) => ({
      ...ext,
      enabled: ext.isEnabled,
      size: 0,
      installedAt: ext.createdAt,
    }));
    return json({ extensions: projected });
  });
}
