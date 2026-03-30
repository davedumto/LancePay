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

  const parsedPage = parseInt(searchParams.get('page') || '1', 10)
  const page = Number.isNaN(parsedPage) || parsedPage < 1 ? 1 : parsedPage

  const parsedLimit = parseInt(searchParams.get('limit') || '20', 10)
  const limit = Math.min(50, Math.max(1, Number.isNaN(parsedLimit) ? 20 : parsedLimit))

  const action = searchParams.get('action')

  const where = {
    actorId: user.id,
    ...(action ? { eventType: action } : {}),
  }

  const [total, events] = await Promise.all([
    prisma.auditEvent.count({ where }),
    prisma.auditEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ])

  const totalPages = Math.ceil(total / limit)

  return NextResponse.json({
    events: events.map(event => ({
      id: event.id,
      action: event.eventType,
      resourceType: 'invoice',
      resourceId: event.invoiceId,
      ipAddress: null,
      createdAt: event.createdAt,
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages,
    },
  })
}
