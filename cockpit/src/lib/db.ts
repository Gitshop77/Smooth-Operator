import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db = globalForPrisma.prisma ?? new PrismaClient()

// Cache the singleton on globalThis in ALL environments so it survives
// serverless/edge cold-starts (the canonical Next.js pattern). The previous
// guard `!== 'production'` was effectively backwards and would have spawned a
// fresh client per cold start on any serverless host, exhausting the
// connection pool.
globalForPrisma.prisma = db