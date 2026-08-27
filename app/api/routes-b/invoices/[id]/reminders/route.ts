import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// GET /api/routes-b/invoices/[id]/reminders — invoice reminder history

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const invoice = await prisma.invoice.findFirst({ where: { id, userId: user.id } })
    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })

    const reminders = await prisma.paymentReminder.findMany({
      where: { invoiceId: id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        reminderType: true,
        daysOffset: true,
        sentAt: true,
        createdAt: true,
      },
    })

    return NextResponse.json({
      invoiceId: id,
      reminders: reminders.map((r) => ({
        id: r.id,
        reminderType: r.reminderType,
        daysOffset: r.daysOffset,
        sentAt: r.sentAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
      })),
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-b/invoices/[id]/reminders error')
    return NextResponse.json({ error: 'Failed to fetch invoice reminders' }, { status: 500 })
  }
}
