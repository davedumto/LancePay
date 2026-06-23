import { withRequestId } from '../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireScope, RoutesBForbiddenError } from '../_lib/authz'
import { errorResponse } from '../_lib/errors'
import { z } from 'zod'

const CreateDisputeSchema = z.object({
  invoiceId: z.string().uuid(),
  reason: z.string().min(1).max(2000),
  requestedAction: z.string().min(1).max(500),
})

async function GETHandler(request: NextRequest) {
  try {
    const auth = await requireScope(request, 'routes-b:read')

    const disputes = await prisma.dispute.findMany({
      where: {
        invoice: { userId: auth.userId },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        invoiceId: true,
        reason: true,
        requestedAction: true,
        status: true,
        resolution: true,
        createdAt: true,
        updatedAt: true,
        resolvedAt: true,
      },
    })

    return NextResponse.json({ disputes })
  } catch (error) {
    if (error instanceof RoutesBForbiddenError) {
      return errorResponse('UNAUTHORIZED', 'Authentication required', {}, 401)
    }
    return errorResponse('INTERNAL', 'Failed to list disputes', {}, 500)
  }
}

async function POSTHandler(request: NextRequest) {
  try {
    const auth = await requireScope(request, 'routes-b:read')

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return errorResponse('BAD_REQUEST', 'Invalid JSON body', {}, 400)
    }

    const parsed = CreateDisputeSchema.safeParse(body)
    if (!parsed.success) {
      const fields: Record<string, string> = {}
      for (const issue of parsed.error.issues) {
        const key = issue.path.join('.')
        fields[key] = issue.message
      }
      return errorResponse('BAD_REQUEST', 'Validation failed', { fields }, 400)
    }

    const { invoiceId, reason, requestedAction } = parsed.data

    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, userId: auth.userId },
      select: { id: true, clientEmail: true },
    })

    if (!invoice) {
      return errorResponse('NOT_FOUND', 'Invoice not found', {}, 404)
    }

    const existing = await prisma.dispute.findUnique({ where: { invoiceId } })
    if (existing) {
      return errorResponse('CONFLICT', 'A dispute already exists for this invoice', {}, 409)
    }

    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: { email: true },
    })

    const dispute = await prisma.dispute.create({
      data: {
        invoiceId,
        initiatedBy: auth.userId,
        initiatorEmail: user?.email ?? '',
        reason,
        requestedAction,
        status: 'open',
      },
      select: {
        id: true,
        invoiceId: true,
        reason: true,
        requestedAction: true,
        status: true,
        createdAt: true,
      },
    })

    return NextResponse.json({ dispute }, { status: 201 })
  } catch (error) {
    if (error instanceof RoutesBForbiddenError) {
      return errorResponse('UNAUTHORIZED', 'Authentication required', {}, 401)
    }
    return errorResponse('INTERNAL', 'Failed to create dispute', {}, 500)
  }
}

export const GET = withRequestId(GETHandler)
export const POST = withRequestId(POSTHandler)
