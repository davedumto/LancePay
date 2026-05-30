import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import {
  unauthorized,
  badRequest,
  notFound,
  forbidden,
  unprocessableEntity,
  internalServerError,
  preconditionFailed,
} from '../../_shared/error'
import { createHash } from 'crypto'
import { invalidateDashboardCache } from '../../../_shared/cache'

function generateETag(id: string, description: string, updatedAt: Date): string {
  const hash = createHash('sha256')
  hash.update(`${id}:${description}:${updatedAt.toISOString()}`)
  return `"${hash.digest('hex').substring(0, 8)}"`
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')

    if (!claims) {
      return unauthorized()
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })

    if (!user) {
      return unauthorized()
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        description: true,
        updatedAt: true,
      },
    })

    if (!invoice) {
      return notFound('Invoice not found')
    }

    if (invoice.userId !== user.id) {
      return forbidden()
    }

    const eTag = generateETag(invoice.id, invoice.description || '', invoice.updatedAt)
    const response = NextResponse.json(
      {
        id: invoice.id,
        description: invoice.description,
      },
      { status: 200 }
    )
    response.headers.set('ETag', eTag)
    return response
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/invoices/[id]/description error')
    return internalServerError()
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')

    if (!claims) {
      return unauthorized()
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })

    if (!user) {
      return unauthorized()
    }

    let body: { description?: unknown }
    try {
      body = await request.json()
    } catch {
      return badRequest('Invalid JSON body')
    }

    const { description } = body

    if (!description || typeof description !== 'string' || description.trim() === '') {
      return badRequest('Description is required and must be a non-empty string')
    }

    if (description.length > 500) {
      return badRequest('Description must not exceed 500 characters')
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        status: true,
        description: true,
        updatedAt: true,
      },
    })

    if (!invoice) {
      return notFound('Invoice not found')
    }

    if (invoice.userId !== user.id) {
      return forbidden()
    }

    if (invoice.status !== 'pending') {
      return unprocessableEntity('Only pending invoices can be updated')
    }

    const ifMatch = request.headers.get('if-match')
    if (ifMatch) {
      const currentETag = generateETag(invoice.id, invoice.description || '', invoice.updatedAt)
      if (ifMatch !== currentETag) {
        return preconditionFailed('ETag mismatch - invoice may have been modified')
      }
    }

    const updatedInvoice = await prisma.invoice.update({
      where: { id },
      data: {
        description: description.trim(),
      },
      select: {
        id: true,
        invoiceNumber: true,
        description: true,
        updatedAt: true,
      },
    })

    const newETag = generateETag(updatedInvoice.id, updatedInvoice.description, updatedInvoice.updatedAt)
    const response = NextResponse.json(updatedInvoice, { status: 200 })
    response.headers.set('ETag', newETag)
    return response
  } catch (error) {
    logger.error({ err: error }, 'PATCH /api/routes-d/invoices/[id]/description error')
    return internalServerError()
  }
}
