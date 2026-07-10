// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { json, withRouteError } from '@/lib/cowork/api/http';
import { db } from '@/lib/db';

export async function GET(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    const enabled = req.nextUrl.searchParams.get('enabled');
    const extensions = enabled !== null
      ? await db.extension.findMany({ where: { isEnabled: enabled === 'true' } })
      : await db.extension.findMany();
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
