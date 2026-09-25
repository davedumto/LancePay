import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import {
  SAVED_FILTER_ENTITY_INVOICE,
  buildInvoiceWhere,
  parseInvoiceFilterDefinition,
} from '@/lib/saved-filters'

const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100

/**
 * POST /api/saved-filters/[id]/execute?page=&pageSize=
 * Runs one of the caller's saved invoice filters against their own invoices.
 * The stored definition is re-validated on every run and translated through
 * the same allowlist used when saving, so rows written by older versions or
 * edited by hand are rejected rather than passed through to Prisma.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { id } = await params
    if (!id || id.trim() === '') {
      return NextResponse.json({ error: 'Saved filter ID is required' }, { status: 400 })
    }

    const savedFilter = await prisma.savedFilter.findFirst({
      where: { id, userId: user.id, entityType: SAVED_FILTER_ENTITY_INVOICE },
      select: { id: true, name: true, filters: true },
    })
    if (!savedFilter) {
      return NextResponse.json({ error: 'Saved filter not found' }, { status: 404 })
    }

    const definition = parseInvoiceFilterDefinition(savedFilter.filters)
    if (!definition.success) {
      logger.warn({ userId: user.id, savedFilterId: id }, 'Stored saved filter failed validation')
      return NextResponse.json(
        { error: 'Saved filter definition is no longer valid', details: definition.errors },
        { status: 422 },
      )
    }

    const searchParams = new URL(request.url).searchParams
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1)
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseInt(searchParams.get('pageSize') || String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE),
    )

    const where = buildInvoiceWhere(definition.definition, user.id)

    const [totalRows, invoices] = await Promise.all([
      prisma.invoice.count({ where }),
      prisma.invoice.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          invoiceNumber: true,
          clientEmail: true,
          clientName: true,
          description: true,
          amount: true,
          currency: true,
          status: true,
          dueDate: true,
          paidAt: true,
          createdAt: true,
        },
      }),
    ])

    return NextResponse.json({
      savedFilter: { id: savedFilter.id, name: savedFilter.name },
      invoices: invoices.map((invoice) => ({ ...invoice, amount: Number(invoice.amount) })),
      pagination: {
        page,
        pageSize,
        totalRows,
        totalPages: Math.max(1, Math.ceil(totalRows / pageSize)),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/saved-filters/[id]/execute error')
    return NextResponse.json({ error: 'Failed to execute saved filter' }, { status: 500 })
  }
}
