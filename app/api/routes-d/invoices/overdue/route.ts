import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── GET /api/routes-d/invoices/overdue - list overdue invoices for current user ──

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const now = new Date()

    const overdue = await prisma.invoice.findMany({
      where: {
        userId: user.id,
        status: 'pending',
        dueDate: { lt: now, not: null },
      },
      orderBy: { dueDate: 'asc' },
    })

    const invoices = overdue.map((inv) => ({
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      clientName: inv.clientName,
      amount: Number(inv.amount),
      currency: inv.currency,
      dueDate: inv.dueDate,
      daysOverdue: Math.floor(
        (now.getTime() - inv.dueDate!.getTime()) / (1000 * 60 * 60 * 24)
      ),
    }))

    return NextResponse.json({ invoices, count: invoices.length })
  } catch (error) {
    logger.error({ err: error }, 'Overdue invoices GET error')
    return NextResponse.json({ error: 'Failed to get overdue invoices' }, { status: 500 })
  }
}
