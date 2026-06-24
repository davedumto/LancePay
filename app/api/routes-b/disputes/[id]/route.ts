import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireScope, RoutesBForbiddenError } from '../../_lib/authz'
import { errorResponse } from '../../_lib/errors'
import { z } from 'zod'

const ParamSchema = z.string().uuid()

async function GETHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireScope(request, 'routes-b:read')

    const { id } = await params
    const parsed = ParamSchema.safeParse(id)
    if (!parsed.success) {
      return errorResponse('BAD_REQUEST', 'Invalid dispute ID format', {}, 400)
    }

    const dispute = await prisma.dispute.findUnique({
      where: { id },
      include: {
        invoice: {
          select: { userId: true },
        },
      },
    })

    if (!dispute || dispute.invoice.userId !== auth.userId) {
      return errorResponse('NOT_FOUND', 'Dispute not found', {}, 404)
    }

    // Exclude the invoice property from the response
    const { invoice, ...disputeData } = dispute

    return NextResponse.json({ dispute: disputeData })
  } catch (error) {
    if (error instanceof RoutesBForbiddenError) {
      return errorResponse('UNAUTHORIZED', 'Authentication required', {}, 401)
    }
    return errorResponse('INTERNAL', 'Failed to fetch dispute', {}, 500)
  }
}

export const GET = withRequestId(GETHandler)
