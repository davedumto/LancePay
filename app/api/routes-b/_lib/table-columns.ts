import { prisma } from '@/lib/db'

const columnSupportCache = new Map<string, boolean>()

export async function hasTableColumn(tableName: string, columnName: string): Promise<boolean> {
  const cacheKey = `${tableName}.${columnName}`
  const cached = columnSupportCache.get(cacheKey)
  if (cached !== undefined) {
    return cached
  }

  const rows = await prisma.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ${tableName}
      AND column_name = ${columnName}
    LIMIT 1
  `

  const supported = rows.length > 0
  columnSupportCache.set(cacheKey, supported)
  return supported
}
