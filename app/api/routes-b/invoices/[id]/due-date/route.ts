import { withRequestId } from '../../../_lib/with-request-id'
import { withMethods } from '../../../_lib/with-methods'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { errorResponse } from '../../../_lib/errors'
import { emitStatsInvalidated } from '../../../_lib/events'
import { logger } from '@/lib/logger'
import { z } from 'zod'

const invoiceIdParamsSchema = z.object({
  id: z.string().uuid('Invoice id must be a valid UUID'),
})

const dueDateBodySchema = z.object({
  dueDate: z.union([z.string(), z.null()]),
})

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) {
    return { error: errorResponse('UNAUTHORIZED', 'Unauthorized', undefined, 401) }
  }

  const claims = await verifyAuthToken(authToken)
  if (!claims) {
    return { error: errorResponse('UNAUTHORIZED', 'Unauthorized', undefined, 401) }
  }

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })

  if (!user) {
    return { error: errorResponse('NOT_FOUND', 'User not found', undefined, 404) }
  }

  return { user }
}

function parseDueDate(value: string) {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return { error: 'Must be a valid ISO date string' }
  }

  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)

  const normalizedDueDate = new Date(parsed)
  normalizedDueDate.setUTCHours(0, 0, 0, 0)

  if (normalizedDueDate < today) {
    return { error: 'Due date cannot be in the past' }
  }

  return { dueDate: parsed }
}

async function PATCHHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const parsedParams = invoiceIdParamsSchema.safeParse({ id })
    if (!parsedParams.success) {
      return errorResponse(
        'BAD_REQUEST',
        'Invalid invoice id',
        { fields: { id: 'Must be a valid UUID' } },
        400,
      )
    }

    const auth = await getAuthenticatedUser(request)
    if ('error' in auth) return auth.error

    const invoice = await prisma.invoice.findUnique({
      where: { id: parsedParams.data.id },
      select: {
        id: true,
        userId: true,
        status: true,
      },
    })

    if (!invoice || invoice.userId !== auth.user.id) {
      return errorResponse('NOT_FOUND', 'Invoice not found', undefined, 404)
    }

    if (invoice.status !== 'pending') {
      return errorResponse(
        'BAD_REQUEST',
        'Due date can only be updated on pending invoices',
        undefined,
        422,
      )
    }

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return errorResponse(
        'BAD_REQUEST',
        'Invalid JSON body',
        { fields: { body: 'Must be a valid JSON object' } },
        400,
      )
    }

    const parsedBody = dueDateBodySchema.safeParse(body)
    if (!parsedBody.success) {
      return errorResponse(
        'BAD_REQUEST',
        'Invalid due date payload',
        { fields: { dueDate: 'Must be an ISO date string or null' } },
        400,
      )
    }

    let dueDate: Date | null = null
    if (parsedBody.data.dueDate !== null) {
      const parsedDueDate = parseDueDate(parsedBody.data.dueDate)
      if ('error' in parsedDueDate) {
        return errorResponse(
          'BAD_REQUEST',
          'Invalid due date',
          { fields: { dueDate: parsedDueDate.error } },
          400,
        )
      }
      dueDate = parsedDueDate.dueDate
    }

    const updatedInvoice = await prisma.invoice.update({
      where: { id: invoice.id },
      data: { dueDate },
      select: {
        id: true,
        invoiceNumber: true,
        dueDate: true,
      },
    })

    emitStatsInvalidated({ userId: auth.user.id })

    return NextResponse.json({ invoice: updatedInvoice }, { status: 200 })
  } catch (error) {
    logger.error({ err: error }, 'PATCH /api/routes-b/invoices/[id]/due-date error')
    return errorResponse('INTERNAL', 'Failed to update invoice due date', undefined, 500)
  }
}

export const { PATCH } = withMethods({
  PATCH: withRequestId(PATCHHandler),
})
