import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireScope, RoutesBForbiddenError } from '../../_lib/authz'
import { registerRoute } from '../../_lib/openapi'
import { errorResponse } from '../../_lib/errors'
import { z } from 'zod'

const BulkStatusUpdateSchema = z.object({
  ids: z.array(z.string()).min(1).max(100),
  status: z.enum(['cancelled', 'paid']),
})

registerRoute({
  method: 'POST',
  path: '/invoices/bulk-status',
  summary: 'Bulk update invoice status',
  description: 'Update the status of multiple invoices at once. Max 100 IDs per request. Only invoices owned by the user will be updated.',
  requestSchema: BulkStatusUpdateSchema,
  responseSchema: z.object({
    results: z.array(z.object({
      id: z.string(),
      ok: z.boolean(),
      error: z.string().optional()
    }))
  }),
  tags: ['invoices']
})

async function POSTHandler(request: NextRequest) {
  try {
    const auth = await requireScope(request, 'routes-b:write')
    
    const body = await request.json().catch(() => ({}))
    const validation = BulkStatusUpdateSchema.safeParse(body)
    
    if (!validation.success) {
      return NextResponse.json(
        { 
          error: 'Invalid request', 
          details: validation.error.flatten().fieldErrors 
        }, 
        { status: 400 }
      )
    }

    const { ids, status } = validation.data

    // Find invoices that belong to the user
    const ownedInvoices = await prisma.invoice.findMany({
      where: {
        id: { in: ids },
        userId: auth.userId
      },
      select: { id: true }
    })

    const ownedIds = new Set(ownedInvoices.map(i => i.id))

    // Perform bulk update for owned invoices
    if (ownedInvoices.length > 0) {
      await prisma.invoice.updateMany({
        where: {
          id: { in: Array.from(ownedIds) },
          userId: auth.userId // Redundant but safe
        },
        data: { status }
      })
    }

    // Prepare per-ID results
    const results = ids.map(id => {
      const ok = ownedIds.has(id)
      return {
        id,
        ok,
        ...(ok ? {} : { error: 'Invoice not found or access denied' })
      }
    })

    return NextResponse.json({ results })

  } catch (error) {
    if (error instanceof RoutesBForbiddenError) {
      return errorResponse(
        'FORBIDDEN',
        'Forbidden',
        { scope: error.code },
        403,
        request.headers.get('x-request-id')
      )
    }
    console.error('[BulkStatusUpdate] Error:', error)
    return errorResponse(
      'INTERNAL_SERVER_ERROR',
      'An unexpected error occurred',
      undefined,
      500,
      request.headers.get('x-request-id')
    )
  }
}

export const POST = withRequestId(POSTHandler)
