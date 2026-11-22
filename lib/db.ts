import { PrismaClient } from '@prisma/client'
import { buildDatabaseUrl } from './db-url'

const globalForPrisma = global as unknown as { prisma: PrismaClient }

// Runtime queries use the pooled Neon URL (DATABASE_URL) with serverless-safe
// pool settings; migrations use DIRECT_URL (see prisma/schema.prisma and
// docs/DEVOPS.md). When DATABASE_URL is unset Prisma reports it at connect time.
const datasourceUrl = buildDatabaseUrl(process.env.DATABASE_URL)

export const prisma = globalForPrisma.prisma || new PrismaClient({
  ...(datasourceUrl ? { datasourceUrl } : {}),
  log: process.env.NODE_ENV === 'development' ? ['query'] : [],
})

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
