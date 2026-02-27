import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthContext, isAdminEmail } from '@/app/api/routes-d/disputes/_shared'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthContext(request)
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: 401 })

    const status = request.nextUrl.searchParams.get('status') || undefined
    const invoiceId = request.nextUrl.searchParams.get('invoiceId') || undefined

    const admin = isAdminEmail(auth.email)

    const where: any = {}
    if (status) where.status = status
    if (invoiceId) where.invoiceId = invoiceId

    if (!admin) {
      where.OR = [
        { invoice: { userId: auth.user.id } },
        { invoice: { clientEmail: auth.email } },
        { initiatorEmail: auth.email },
      ]
    }

    const disputes = await prisma.dispute.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        invoiceId: true,
        initiatedBy: true,
        reason: true,
        status: true,
        createdAt: true,
        invoice: { select: { invoiceNumber: true } },
      },
    })

    return NextResponse.json({
      disputes: disputes.map((d) => ({
        id: d.id,
        invoiceId: d.invoiceId,
        invoiceNumber: d.invoice.invoiceNumber,
        initiatedBy: d.initiatedBy,
        reason: d.reason,
        status: d.status,
        createdAt: d.createdAt.toISOString(),
      })),
    })
  } catch (error) {
    logger.error({ err: error }, 'Disputes list error:')
    return NextResponse.json({ error: 'Failed to list disputes' }, { status: 500 })
  }
}

