import { decodeCursor, encodeCursor } from './cursor'

export type PaginationParams = {
  cursor?: string | null
  limit?: string | null
}

export function getCursorPagination(params: PaginationParams, defaultLimit = 20) {
  const limit = params.limit ? parseInt(params.limit, 10) : defaultLimit
  const safeLimit = Math.min(Math.max(isNaN(limit) ? defaultLimit : limit, 1), 100)
  
  const decodedCursor = params.cursor ? decodeCursor(params.cursor) : null
  
  const cursorWhere = decodedCursor ? {
    OR: [
      { createdAt: { lt: new Date(decodedCursor.createdAt) } },
      {
        AND: [
          { createdAt: new Date(decodedCursor.createdAt) },
          { id: { lt: decodedCursor.id } },
        ],
      },
    ],
  } : {}
  
  return {
    limit: safeLimit,
    where: cursorWhere,
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
    take: safeLimit + 1,
    isValidCursor: !params.cursor || !!decodedCursor
  }
}

export function buildPaginationResponse<T extends { id: string, createdAt: Date }>(items: T[], limit: number) {
  const hasNextPage = items.length > limit
  const data = hasNextPage ? items.slice(0, limit) : items
  const lastItem = data.length > 0 && hasNextPage ? data[data.length - 1] : null
  
  const nextCursor = lastItem
    ? encodeCursor({ createdAt: lastItem.createdAt.toISOString(), id: lastItem.id })
    : null
    
  return { data, nextCursor }
}
