import { PrismaClient } from '@prisma/client'

const SLOW_QUERY_THRESHOLD_MS = 100

const globalForPrisma = global as unknown as { prisma: PrismaClient }

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: [
      { level: 'query', emit: 'event' },
      { level: 'warn', emit: 'stdout' },
      { level: 'error', emit: 'stdout' },
    ],
  })

prisma.$on('query', (e) => {
  if (e.duration > SLOW_QUERY_THRESHOLD_MS) {
    console.warn(`[db] slow query (${e.duration}ms): ${e.query}`)
  }
})

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
