import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: invoiceId } = await params

    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')

    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, userId: true },
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    if (invoice.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const activity = await prisma.auditEvent.findMany({
      where: {
        resourceType: 'invoice',
        resourceId: invoiceId,
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        action: true,
        ipAddress: true,
        createdAt: true,
      },
    })

    return NextResponse.json({ activity }, { status: 200 })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/invoices/[id]/activity error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
