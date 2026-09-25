import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { SAVED_FILTER_ENTITY_INVOICE, parseInvoiceFilterDefinition } from '@/lib/saved-filters'

const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100

const createSavedFilterSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    definition: z.unknown(),
  })
  .strict()

const savedFilterSelect = {
  id: true,
  name: true,
  entityType: true,
  filters: true,
  isDefault: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SavedFilterSelect

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

/**
 * GET /api/saved-filters
 * Lists the caller's saved invoice filters, newest first.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const searchParams = new URL(request.url).searchParams
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1)
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseInt(searchParams.get('pageSize') || String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE),
    )

    const where = { userId: user.id, entityType: SAVED_FILTER_ENTITY_INVOICE }

    const [totalRows, savedFilters] = await Promise.all([
      prisma.savedFilter.count({ where }),
      prisma.savedFilter.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: savedFilterSelect,
      }),
    ])

    return NextResponse.json({
      savedFilters,
      pagination: {
        page,
        pageSize,
        totalRows,
        totalPages: Math.max(1, Math.ceil(totalRows / pageSize)),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/saved-filters error')
    return NextResponse.json({ error: 'Failed to fetch saved filters' }, { status: 500 })
  }
}

/**
 * POST /api/saved-filters
 * Saves a validated invoice filter definition under a name unique to the caller.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = createSavedFilterSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      )
    }

    const definition = parseInvoiceFilterDefinition(parsed.data.definition)
    if (!definition.success) {
      return NextResponse.json(
        { error: 'Invalid filter definition', details: definition.errors },
        { status: 400 },
      )
    }

    const savedFilter = await prisma.savedFilter.create({
      data: {
        userId: user.id,
        name: parsed.data.name,
        entityType: SAVED_FILTER_ENTITY_INVOICE,
        filters: definition.definition as unknown as Prisma.InputJsonObject,
      },
      select: savedFilterSelect,
    })

    return NextResponse.json({ savedFilter }, { status: 201 })
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return NextResponse.json(
        { error: 'You already have a saved filter with this name' },
        { status: 409 },
      )
    }
    logger.error({ err: error }, 'POST /api/saved-filters error')
    return NextResponse.json({ error: 'Failed to save filter' }, { status: 500 })
  }
}
