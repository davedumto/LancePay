import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    // Verify auth
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
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Get overdue invoices (past due date and still pending)
    const now = new Date()
    const overdueInvoices = await prisma.invoice.findMany({
      where: {
        userId: user.id,
        status: 'pending',
        dueDate: { lt: now },
      },
      orderBy: { dueDate: 'asc' },
    })

    return NextResponse.json({ invoices: overdueInvoices })
  } catch (error) {
    logger.error({ err: error }, 'Overdue invoices error')
    return NextResponse.json({ error: 'Failed to get overdue invoices' }, { status: 500 })
  }
}