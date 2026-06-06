import { withRequestId } from '../../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { applyDiscount, removeDiscount } from '../../../_lib/discounts'
import { registerRoute } from '../../../_lib/openapi'
import { z } from 'zod'

// Register OpenAPI documentation
registerRoute({
  method: 'POST',
  path: '/invoices/{id}/discount',
  summary: 'Apply discount to invoice',
  description: 'Apply a percentage or flat discount to an invoice. Recomputes total.',
  requestSchema: z.object({
    id: z.string().describe('Invoice ID'),
    type: z.enum(['percent', 'flat']),
    value: z.number().nonnegative(),
    code: z.string().optional()
  }),
  responseSchema: z.object({
    id: z.string(),
    amount: z.number(),
    status: z.string()
  }),
  tags: ['invoices']
})

registerRoute({
  method: 'DELETE',
  path: '/invoices/{id}/discount',
  summary: 'Remove discount from invoice',
  description: 'Remove the applied discount and revert the invoice total.',
  requestSchema: z.object({
    id: z.string().describe('Invoice ID')
  }),
  responseSchema: z.object({
    id: z.string(),
    amount: z.number()
  }),
  tags: ['invoices']
})

async function POSTHandler(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { id } = params
    const invoice = await prisma.invoice.findUnique({
      where: { id, userId: user.id }
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    if (invoice.status === 'paid' || invoice.status === 'cancelled') {
      return NextResponse.json({ error: 'Cannot apply discount to paid or cancelled invoice' }, { status: 400 })
    }

    const body = await request.json()
    const { type, value, code } = body

    const updatedInvoice = await applyDiscount(id, { type, value, code })

    return NextResponse.json({
      id: updatedInvoice.id,
      amount: Number(updatedInvoice.amount),
      status: updatedInvoice.status
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to apply discount' }, { status: 500 })
  }
}

async function DELETEHandler(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { id } = params
    const invoice = await prisma.invoice.findUnique({
      where: { id, userId: user.id }
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    if (invoice.status === 'paid' || invoice.status === 'cancelled') {
      return NextResponse.json({ error: 'Cannot remove discount from paid or cancelled invoice' }, { status: 400 })
    }

    const updatedInvoice = await removeDiscount(id)

    return NextResponse.json({
      id: updatedInvoice.id,
      amount: Number(updatedInvoice.amount)
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to remove discount' }, { status: 500 })
  }
}

export const POST = withRequestId(POSTHandler)
export const DELETE = withRequestId(DELETEHandler)
