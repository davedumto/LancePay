import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { createRouteLogger } from '../_shared/logger'

const log = createRouteLogger({ route: '/api/routes-d/audit-log' })
const MAX_DATE_RANGE_DAYS = 365
const DEFAULT_DATE_RANGE_DAYS = 90

function parseAuditFilters(searchParams: URLSearchParams) {
  const fromParam = searchParams.get('from')
  const toParam = searchParams.get('to')

  const now = new Date()
  const from = fromParam ? new Date(fromParam) : new Date(now.getTime() - DEFAULT_DATE_RANGE_DAYS * 24 * 60 * 60 * 1000)
  const to = toParam ? new Date(toParam) : now

  if (fromParam && isNaN(from.getTime())) {
    return { ok: false, error: 'Invalid from date' as const }
  }
  if (toParam && isNaN(to.getTime())) {
    return { ok: false, error: 'Invalid to date' as const }
  }
  if (from > to) {
    return { ok: false, error: 'from must be before or equal to to' as const }
  }

  const rangeMs = to.getTime() - from.getTime()
  if (rangeMs > MAX_DATE_RANGE_DAYS * 24 * 60 * 60 * 1000) {
    return { ok: false, error: `date range cannot exceed ${MAX_DATE_RANGE_DAYS} days` as const }
  }

  return { ok: true, value: { from, to } }
}

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { searchParams } = new URL(request.url)
    const rawLimit = parseInt(searchParams.get('limit') || '20', 10)
    const limit = Math.min(isNaN(rawLimit) || rawLimit <= 0 ? 20 : rawLimit, 100)
    const action = searchParams.get('action')

    const parsedFilters = parseAuditFilters(searchParams)
    if (!parsedFilters.ok) {
      return NextResponse.json({ error: parsedFilters.error }, { status: 400 })
    }

    const events = await prisma.auditEvent.findMany({
      where: {
        actorId: user.id,
        ...(action ? { eventType: action } : {}),
        createdAt: {
          gte: parsedFilters.value.from,
          lte: parsedFilters.value.to,
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })

    return NextResponse.json({
      events: events.map(event => ({
        id: event.id,
        action: event.eventType,
        resourceType: 'invoice',
        resourceId: event.invoiceId,
        createdAt: event.createdAt,
      })),
    })
  } catch (error) {
    log.error({ err: error }, 'Audit log GET error')
    return NextResponse.json({ error: 'Failed to get audit log' }, { status: 500 })
  }
}
