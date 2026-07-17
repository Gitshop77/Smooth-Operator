// Prisma 7 configuration.
//
// In Prisma 7 the datasource connection URL is no longer declared in
// `schema.prisma` (the `url` property was removed). Instead it is supplied here
// via `prisma.config.ts`, and the `PrismaClient` constructor receives a driver
// adapter rather than a connection string. See:
//   - https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7
//
// SECURITY NOTE: nothing in this file changes authentication, redaction, or
// audit behavior. It only wires the SQLite connection. The S2S token,
// redactSecrets, brute-force throttle keying, and mass-delete gating all live
// in the API routes and are untouched.

import 'dotenv/config'
import { defineConfig, env } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
})
