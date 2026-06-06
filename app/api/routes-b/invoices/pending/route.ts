import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { getArchiveFilter, parseIncludeArchivedParam } from '../../_lib/invoice-archive'
import { decodeCursor, encodeCursor } from '../../_lib/cursor'
import { z } from 'zod'

/**
 * GET /api/routes-b/invoices/pending
 *
 * List pending invoices for the authenticated user with cursor-based pagination.
 *
 * Query parameters:
 *   - limit: number (1-100, default 25)
 *   - cursor: base64url-encoded JSON { createdAt, id }
 *   - includeArchived: boolean (default false)
 *
 * Response: { invoices: Invoice[], nextCursor: string | null }
 *
 * Auth: Bearer token required. User must exist in database.
 */

// ── Validation schemas ──

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
  includeArchived: z.enum(['true', 'false']).optional().default('false'),
})

type QueryInput = z.infer<<typeof QuerySchema>

// ── Error envelopes matching routes-b conventions ──

function errorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string | null,
) {
  return NextResponse.json(
    { error: { code, message }, requestId },
    { status },
  )
}

// ── Handler ──

async function GETHandler(request: NextRequest) {
  // 1. Auth: extract and verify Bearer token
  const authHeader = request.headers.get('authorization')
  if (!authHeader) {
    return errorResponse(401, 'UNAUTHORIZED', 'Missing Authorization header', null)
  }

  const authToken = authHeader.replace(/^Bearer\s+/i, '')
  if (!authToken) {
    return errorResponse(401, 'UNAUTHORIZED', 'Empty Bearer token', null)
  }

  const claims = await verifyAuthToken(authToken)
  if (!claims) {
    return errorResponse(401, 'UNAUTHORIZED', 'Invalid or expired token', null)
  }

  // 2. Ownership: resolve user from privyId
  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true, privyId: true },
  })

  if (!user) {
    return errorResponse(404, 'USER_NOT_FOUND', 'User not found', null)
  }

  // 3. Query validation
  const { searchParams } = new URL(request.url)
  const raw = {
    limit: searchParams.get('limit') ?? undefined,
    cursor: searchParams.get('cursor') ?? undefined,
    includeArchived: searchParams.get('includeArchived') ?? undefined,
  }

  const parseResult = QuerySchema.safeParse(raw)
  if (!parseResult.success) {
    const issues = parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
    return errorResponse(400, 'VALIDATION_ERROR', issues.join('; '), null)
  }

  const { limit, cursor, includeArchived } = parseResult.data
  const includeArchivedBool = includeArchived === 'true'

  // 4. Cursor decoding
  let decodedCursor: { createdAt: string; id: string } | null = null
  if (cursor) {
    decodedCursor = decodeCursor(cursor)
    if (!decodedCursor) {
      return errorResponse(400, 'INVALID_CURSOR', 'Malformed or expired cursor', null)
    }
  }

  // 5. Build Prisma where clause
  const where = {
    userId: user.id,
    status: 'pending',
    ...getArchiveFilter(includeArchivedBool),
    ...(decodedCursor
      ? {
          OR: [
            { createdAt: { lt: new Date(decodedCursor.createdAt) } },
            {
              AND: [
                { createdAt: new Date(decodedCursor.createdAt) },
                { id: { lt: decodedCursor.id } },
              ],
            },
          ],
        }
      : {}),
  }

  // 6. Fetch invoices (limit + 1 to detect next page)
  const invoices = await prisma.invoice.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      invoiceNumber: true,
      clientName: true,
      amount: true,
      dueDate: true,
      createdAt: true,
      status: true,
      archivedAt: true,
    },
  })

  const hasNext = invoices.length > limit
  const page = hasNext ? invoices.slice(0, limit) : invoices
  const last = page[page.length - 1]

  // 7. Response envelope
  return NextResponse.json({
    invoices: page.map((invoice) => ({
      ...invoice,
      amount: Number(invoice.amount),
    })),
    nextCursor:
      hasNext && last
        ? encodeCursor({
            createdAt: last.createdAt.toISOString(),
            id: last.id,
          })
        : null,
  })
}

export const GET = withRequestId(GETHandler)