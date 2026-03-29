import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── GET /api/routes-d/invoices/[id]/payment-status - check invoice payment status ──

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    // Optional auth - verify if present, but do not require it
    let userId: string | null = null
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (authToken) {
      const claims = await verifyAuthToken(authToken)
      if (claims) {
        const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
        userId = user?.id ?? null
      }
    }

    // Find invoice by ID or invoiceNumber
    let invoice = await prisma.invoice.findUnique({ where: { id } })
    if (!invoice) {
      invoice = await prisma.invoice.findUnique({ where: { invoiceNumber: id } })
    }
    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    return NextResponse.json({
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
      amount: Number(invoice.amount),
      currency: invoice.currency,
      paidAt: invoice.paidAt,
      dueDate: invoice.dueDate,
    })
  } catch (error) {
    logger.error({ err: error }, 'Payment status GET error')
    return NextResponse.json({ error: 'Failed to get payment status' }, { status: 500 })
  }
}
