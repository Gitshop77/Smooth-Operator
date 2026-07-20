import 'server-only'

import { PrismaClient } from '@prisma/client'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'

// Prisma 7 requires a driver adapter for the actual database connection. The
// connection URL is sourced from the environment (DATABASE_URL), which is
// declared in prisma.config.ts and loaded via dotenv at config/build time.
// We never log the URL or any connection string here.
const connectionString = process.env.DATABASE_URL || 'file:./db/cowork.db'

const adapter = new PrismaBetterSqlite3({
  url: connectionString,
})

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    // Keep error + warn for diagnosability in all environments. We deliberately
    // do NOT log Prisma 'query' events: they echo bound parameter values
    // (user-supplied URLs, form-memory values, tokens) unredacted, which would
    // bypass the repo's redactSecrets contract that gates every other server
    // log path.
    log: ['error', 'warn'],
  })

// Cache the singleton on globalThis in ALL environments so it survives dev HMR
// reloads and warm serverless invocations. globalThis is per-process, so a cold
// start still recreates the client.
globalForPrisma.prisma = db
