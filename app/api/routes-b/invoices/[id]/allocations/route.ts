import { withRequestId } from '../../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireScope, RoutesBForbiddenError } from '../../../_lib/authz'
import { errorResponse } from '../../../_lib/errors'
import { z } from 'zod'
import { Decimal } from '@prisma/client/runtime/library'

const CreateAllocationSchema = z.object({
  amount: z.number().positive(),
  allocationType: z.enum(['subcontractor', 'expense', 'tax', 'reserve', 'other']),
  recipientId: z.string().uuid().optional(),
  recipientName: z.string().min(1).max(200).optional(),
  description: z.string().min(1).max(500),
})

async function GETHandler(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await requireScope(request, 'routes-b:read')
    const invoiceId = (await params).id

    // Verify invoice exists and belongs to user
    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, userId: auth.userId },
      select: { id: true },
    })

    if (!invoice) {
      return errorResponse('NOT_FOUND', 'Invoice not found', {}, 404)
    }

    const allocations = await prisma.invoiceAllocation.findMany({
      where: { invoiceId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        amount: true,
        allocationType: true,
        recipientId: true,
        recipientName: true,
        description: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return NextResponse.json({ allocations })
  } catch (error) {
    if (error instanceof RoutesBForbiddenError) {
      return errorResponse('UNAUTHORIZED', 'Authentication required', {}, 401)
    }
    return errorResponse('INTERNAL', 'Failed to list allocations', {}, 500)
  }
}

async function POSTHandler(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await requireScope(request, 'routes-b:read')
    const invoiceId = (await params).id

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return errorResponse('BAD_REQUEST', 'Invalid JSON body', {}, 400)
    }

    const parsed = CreateAllocationSchema.safeParse(body)
    if (!parsed.success) {
      const fields: Record<string, string> = {}
      for (const issue of parsed.error.issues) {
        const key = issue.path.join('.')
        fields[key] = issue.message
      }
      return errorResponse('BAD_REQUEST', 'Validation failed', { fields }, 400)
    }

    const { amount, allocationType, recipientId, recipientName, description } =
      parsed.data

    // Verify invoice exists and belongs to user
    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, userId: auth.userId },
      select: { id: true, amount: true },
    })

    if (!invoice) {
      return errorResponse('NOT_FOUND', 'Invoice not found', {}, 404)
    }

    // Verify recipientId exists if provided
    if (recipientId) {
      const recipient = await prisma.user.findUnique({
        where: { id: recipientId },
        select: { id: true },
      })

      if (!recipient) {
        return errorResponse(
          'BAD_REQUEST',
          'Recipient user not found',
          {},
          400
        )
      }
    }

    // Calculate total allocations including the new one
    const existingAllocations = await prisma.invoiceAllocation.findMany({
      where: { invoiceId },
      select: { amount: true },
    })

    const totalExisting = existingAllocations.reduce(
      (sum, alloc) => sum.add(alloc.amount),
      new Decimal(0)
    )

    const totalWithNew = totalExisting.add(amount)
    const invoiceAmount = new Decimal(invoice.amount.toString())

    if (totalWithNew.greaterThan(invoiceAmount)) {
      return errorResponse(
        'BAD_REQUEST',
        'Total allocations would exceed invoice amount',
        {
          invoiceAmount: invoice.amount.toString(),
          currentAllocations: totalExisting.toString(),
          requestedAmount: amount.toString(),
          exceeded: totalWithNew.minus(invoiceAmount).toString(),
        },
        400
      )
    }

    const allocation = await prisma.invoiceAllocation.create({
      data: {
        invoiceId,
        amount,
        allocationType,
        recipientId,
        recipientName,
        description,
      },
      select: {
        id: true,
        amount: true,
        allocationType: true,
        recipientId: true,
        recipientName: true,
        description: true,
        createdAt: true,
      },
    })

    return NextResponse.json({ allocation }, { status: 201 })
  } catch (error) {
    if (error instanceof RoutesBForbiddenError) {
      return errorResponse('UNAUTHORIZED', 'Authentication required', {}, 401)
    }
    return errorResponse('INTERNAL', 'Failed to create allocation', {}, 500)
  }
}

export const GET = withRequestId(GETHandler)
export const POST = withRequestId(POSTHandler)
