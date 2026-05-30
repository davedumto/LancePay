import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params

    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const invoice = await prisma.invoice.findUnique({ where: { id } })
    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })

    if (invoice.userId !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const activity = await prisma.auditEvent.findMany({
      where: { invoiceId: id },
      orderBy: { createdAt: 'asc' },
    })

    return NextResponse.json({
      activity: activity.map(event => ({
        id: event.id,
        action: event.eventType,
        resourceType: 'invoice',
        resourceId: event.invoiceId,
        metadata: event.metadata,
        createdAt: event.createdAt,
      })),
    })
  } catch (error) {
    console.error('Error fetching invoice activity:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
