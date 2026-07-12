import 'server-only'

import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db = globalForPrisma.prisma ?? new PrismaClient()

// Cache the singleton on globalThis in ALL environments so it survives
// dev HMR reloads and warm serverless invocations (the canonical Next.js
// pattern). The previous guard `!== 'production'` was effectively backwards
// and would have spawned a fresh client per invocation, exhausting the
// connection pool. Note: globalThis is per-process, so an actual cold start
// (a fresh container/process) still recreates the client — the cache does not
// persist across cold starts.
globalForPrisma.prisma = db