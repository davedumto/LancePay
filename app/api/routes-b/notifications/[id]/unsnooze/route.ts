import { withRequestId } from '../../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { unsnoozeNotification } from '../../../_lib/notification-snooze'

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

  unsnoozeNotification(id)

  return NextResponse.json({ id, snoozedUntil: null })
}

export const POST = withRequestId(POSTHandler)
