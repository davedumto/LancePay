import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

/**
 * GET /api/routes-d/invoices/paid
 * Lists all invoices with status "paid" for the authenticated user.
 */
export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const paidInvoices = await prisma.invoice.findMany({
      where: {
        userId: user.id,
        status: 'paid',
      },
      orderBy: { paidAt: 'desc' },
      select: {
        id: true,
        invoiceNumber: true,
        clientName: true,
        clientEmail: true,
        amount: true,
        currency: true,
        status: true,
        paidAt: true,
        createdAt: true,
      },
    })

    const data = paidInvoices.map((inv) => ({
      ...inv,
      amount: Number(inv.amount),
    }))

    return NextResponse.json({
      invoices: data,
      count: data.length,
    })
  } catch (error) {
    logger.error({ err: error }, 'Paid invoices GET error')
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
