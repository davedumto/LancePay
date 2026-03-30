import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

export async function GET(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const { searchParams } = new URL(request.url)
  const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 100)
  const action = searchParams.get('action')

  const events = await prisma.auditEvent.findMany({
    where: {
      actorId: user.id,
      ...(action ? { eventType: action } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })

  return NextResponse.json({
    events: events.map(event => ({
      id: event.id,
      action: event.eventType,
      resourceType: 'invoice', // Current schema ties AuditEvent to Invoice
      resourceId: event.invoiceId,
      createdAt: event.createdAt,
      // ipAddress is not in the current AuditEvent model, omitting per "Check the schema for the full field list"
    })),
  })
}
