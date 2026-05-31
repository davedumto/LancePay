import { withRequestId } from '../../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { snoozeNotification } from '../../../_lib/notification-snooze'

const MAX_SNOOZE_DAYS = 30
const MAX_SNOOZE_MS = MAX_SNOOZE_DAYS * 24 * 60 * 60 * 1000

interface RouteParams {
  params: Promise<{ id: string }>
}

async function POSTHandler(request: NextRequest, { params }: RouteParams) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const claims = await verifyAuthToken(authToken)
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params

  const notification = await prisma.notification.findUnique({ where: { id } })
  if (!notification) {
    return NextResponse.json({ error: 'Notification not found' }, { status: 404 })
  }
  if (notification.userId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: { until?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 422 })
  }

  if (!body.until) {
    return NextResponse.json(
      { error: 'Validation failed', fields: { until: 'until is required' } },
      { status: 422 },
    )
  }

  const untilDate = new Date(body.until)
  if (Number.isNaN(untilDate.getTime())) {
    return NextResponse.json(
      { error: 'Validation failed', fields: { until: 'until must be a valid ISO datetime' } },
      { status: 422 },
    )
  }

  const now = Date.now()
  if (untilDate.getTime() <= now) {
    return NextResponse.json(
      { error: 'Validation failed', fields: { until: 'until must be in the future' } },
      { status: 422 },
    )
  }

  if (untilDate.getTime() - now > MAX_SNOOZE_MS) {
    return NextResponse.json(
      {
        error: 'Validation failed',
        fields: { until: `until cannot be more than ${MAX_SNOOZE_DAYS} days out` },
      },
      { status: 422 },
    )
  }

  snoozeNotification(id, untilDate)

  return NextResponse.json({ id, snoozedUntil: untilDate.toISOString() })
}

export const POST = withRequestId(POSTHandler)
