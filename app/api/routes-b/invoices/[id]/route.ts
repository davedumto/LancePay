import { withRequestId, getRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { createEntityEtag, ifMatchSatisfied } from '../../_lib/etag'
import { errorResponse } from '../../_lib/errors'
import { logger } from '@/lib/logger'

function isValidIsoDate(value: string) {
  const date = new Date(value)
  return !Number.isNaN(date.getTime())
}

type AuthenticatedUser = {
  id: string
  role: string
}

const PATCHABLE_FIELDS = new Set([
  'description',
  'amount',
  'dueDate',
  'clientName',
])

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) {
    return {
      response: errorResponse('UNAUTHORIZED', 'Unauthorized', { requestId: getRequestId() }, 401),
    }
  }

  const claims = await verifyAuthToken(authToken)
  if (!claims) {
    return {
      response: errorResponse('UNAUTHORIZED', 'Invalid token', { requestId: getRequestId() }, 401),
    }
  }

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true, role: true },
  })

  if (!user) {
    return {
      response: errorResponse('NOT_FOUND', 'User not found', { requestId: getRequestId() }, 404),
    }
  }

  return { user }
}

function invoiceNotFound() {
  return errorResponse('NOT_FOUND', 'Invoice not found', { requestId: getRequestId() }, 404)
}

async function GETHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    if (!id) {
      return errorResponse(
        'BAD_REQUEST',
        'Invalid invoice id',
        { fields: { id: 'Invoice id is required' }, requestId: getRequestId() },
        400,
      )
    }

    const auth = await getAuthenticatedUser(request)
    if (auth.response) return auth.response

    const invoice = await prisma.invoice.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        invoiceNumber: true,
        clientEmail: true,
        clientName: true,
        description: true,
        amount: true,
        currency: true,
        status: true,
        paymentLink: true,
        dueDate: true,
        paidAt: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    if (!invoice || invoice.userId !== auth.user.id) {
      return invoiceNotFound()
    }

    const etag = createEntityEtag(invoice.id, invoice.updatedAt)
    const response = NextResponse.json({
      invoice: {
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        clientName: invoice.clientName,
        clientEmail: invoice.clientEmail,
        description: invoice.description,
        amount: Number(invoice.amount),
        currency: invoice.currency,
        status: invoice.status,
        paymentLink: invoice.paymentLink,
        dueDate: invoice.dueDate,
        paidAt: invoice.paidAt,
        createdAt: invoice.createdAt,
      },
    })
    response.headers.set('ETag', etag)
    return response
  } catch (error) {
    logger.error({ err: error }, 'Routes-B invoice GET error')
    return errorResponse(
      'INTERNAL',
      'Failed to fetch invoice',
      { requestId: getRequestId() },
      500,
    )
  }
}

async function PATCHHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    if (!id) {
      return errorResponse(
        'BAD_REQUEST',
        'Invalid invoice id',
        { fields: { id: 'Invoice id is required' }, requestId: getRequestId() },
        400,
      )
    }

    const auth = await getAuthenticatedUser(request)
    if (auth.response) return auth.response
    const requester = auth.user as AuthenticatedUser

    const ifMatchHeader = request.headers.get('if-match')
    if (!ifMatchHeader) {
      return errorResponse(
        'BAD_REQUEST',
        'If-Match header is required',
        { fields: { 'if-match': 'Header is required' }, requestId: getRequestId() },
        428,
      )
    }

    const wildcardMatch = ifMatchHeader.trim() === '*'
    if (wildcardMatch && requester.role.toLowerCase() !== 'admin') {
      return errorResponse(
        'FORBIDDEN',
        'Wildcard If-Match is admin only',
        { requestId: getRequestId() },
        403,
      )
    }

    const ownedInvoice = await prisma.invoice.findUnique({
      where: { id },
      select: { id: true, userId: true, status: true, updatedAt: true },
    })

    if (!ownedInvoice || ownedInvoice.userId !== requester.id) {
      return invoiceNotFound()
    }

    if (ownedInvoice.status !== 'pending') {
      return errorResponse(
        'BAD_REQUEST',
        'Only pending invoices can be edited',
        { requestId: getRequestId() },
        422,
      )
    }

    if (!wildcardMatch) {
      const currentEtag = createEntityEtag(ownedInvoice.id, ownedInvoice.updatedAt)
      if (!ifMatchSatisfied(ifMatchHeader, currentEtag)) {
        return errorResponse(
          'CONFLICT',
          'ETag mismatch',
          { requestId: getRequestId() },
          412,
        )
      }
    }

    let body: Record<string, unknown>
    try {
      const parsed = await request.json()
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Body must be an object')
      }
      body = parsed
    } catch {
      return errorResponse(
        'BAD_REQUEST',
        'Invalid JSON body',
        { fields: { body: 'Must be a valid JSON object' }, requestId: getRequestId() },
        400,
      )
    }

    const unknownFields = Object.keys(body).filter(key => !PATCHABLE_FIELDS.has(key))
    if (unknownFields.length > 0) {
      return errorResponse(
        'BAD_REQUEST',
        'Invalid invoice fields',
        {
          fields: Object.fromEntries(
            unknownFields.map(field => [field, 'Field cannot be updated by this endpoint']),
          ),
          requestId: getRequestId(),
        },
        400,
      )
    }

    const updateData: {
      description?: string
      amount?: number
      dueDate?: Date | null
      clientName?: string
    } = {}

    if (body.description !== undefined) {
      if (typeof body.description !== 'string' || body.description.trim() === '') {
        return errorResponse(
          'BAD_REQUEST',
          'Invalid description',
          { fields: { description: 'Must be a non-empty string' }, requestId: getRequestId() },
          400,
        )
      }
      if (body.description.length > 500) {
        return errorResponse(
          'BAD_REQUEST',
          'Invalid description',
          { fields: { description: 'Must be 500 characters or fewer' }, requestId: getRequestId() },
          400,
        )
      }
      updateData.description = body.description.trim()
    }

    if (body.amount !== undefined) {
      if (typeof body.amount !== 'number' || !Number.isFinite(body.amount) || body.amount <= 0) {
        return errorResponse(
          'BAD_REQUEST',
          'Invalid amount',
          { fields: { amount: 'Must be a positive number' }, requestId: getRequestId() },
          400,
        )
      }
      updateData.amount = body.amount
    }

    if (body.dueDate !== undefined) {
      if (body.dueDate === null) {
        updateData.dueDate = null
      } else if (typeof body.dueDate === 'string' && isValidIsoDate(body.dueDate)) {
        updateData.dueDate = new Date(body.dueDate)
      } else {
        return errorResponse(
          'BAD_REQUEST',
          'Invalid due date',
          { fields: { dueDate: 'Must be a valid ISO date string or null' }, requestId: getRequestId() },
          400,
        )
      }
    }

    if (body.clientName !== undefined) {
      if (typeof body.clientName !== 'string' || body.clientName.trim() === '') {
        return errorResponse(
          'BAD_REQUEST',
          'Invalid client name',
          { fields: { clientName: 'Must be a non-empty string' }, requestId: getRequestId() },
          400,
        )
      }
      if (body.clientName.length > 100) {
        return errorResponse(
          'BAD_REQUEST',
          'Invalid client name',
          { fields: { clientName: 'Must be 100 characters or fewer' }, requestId: getRequestId() },
          400,
        )
      }
      updateData.clientName = body.clientName.trim()
    }

    if (Object.keys(updateData).length === 0) {
      return errorResponse(
        'BAD_REQUEST',
        'No valid fields provided',
        { requestId: getRequestId() },
        400,
      )
    }

    const updatedInvoice = await prisma.invoice.update({
      where: { id: ownedInvoice.id },
      data: updateData,
      select: {
        id: true,
        invoiceNumber: true,
        description: true,
        amount: true,
        status: true,
        updatedAt: true,
        dueDate: true,
        clientName: true,
        clientEmail: true,
        currency: true,
        paymentLink: true,
        paidAt: true,
        createdAt: true,
      },
    })

    const response = NextResponse.json({
      invoice: { ...updatedInvoice, amount: Number(updatedInvoice.amount) },
    })
    response.headers.set('ETag', createEntityEtag(updatedInvoice.id, updatedInvoice.updatedAt))
    return response
  } catch (error) {
    logger.error({ err: error }, 'Routes-B invoice PATCH error')
    return errorResponse(
      'INTERNAL',
      'Failed to update invoice',
      { requestId: getRequestId() },
      500,
    )
  }
}

export const GET = withRequestId(GETHandler)
export const PATCH = withRequestId(PATCHHandler)
