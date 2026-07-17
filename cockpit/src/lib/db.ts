import 'server-only'

import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
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