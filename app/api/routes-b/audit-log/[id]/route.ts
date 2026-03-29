import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const event = await prisma.auditEvent.findUnique({ where: { id } })

  if (!event) {
    return NextResponse.json({ error: 'Audit event not found' }, { status: 404 })
  }

  if (event.actorId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  return NextResponse.json({
    event: {
      id: event.id,
      action: event.eventType,
      resourceType: 'invoice',
      resourceId: event.invoiceId,
      ipAddress: null,
      userAgent: null,
      createdAt: event.createdAt,
    },
  })
}
