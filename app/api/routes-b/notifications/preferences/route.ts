import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── GET /api/routes-b/notifications/preferences — fetch notification preferences ──
// ── PATCH /api/routes-b/notifications/preferences — update notification preferences ──

const VALID_CHANNELS = ['email', 'sms', 'push'] as const
type Channel = typeof VALID_CHANNELS[number]

type NotificationPrefs = {
  invoicePaid: boolean
  invoiceOverdue: boolean
  paymentFailed: boolean
  newMessage: boolean
  disputeOpened: boolean
  channels: Channel[]
}

type NotificationPrefDelegate = {
  findUnique: (args: Record<string, unknown>) => Promise<(NotificationPrefs & { userId: string }) | null>
  upsert: (args: Record<string, unknown>) => Promise<NotificationPrefs>
}

function getPrefDelegate(): NotificationPrefDelegate {
  return (prisma as unknown as { notificationPreference: NotificationPrefDelegate }).notificationPreference
}

const DEFAULT_PREFS: NotificationPrefs = {
  invoicePaid: true,
  invoiceOverdue: true,
  paymentFailed: true,
  newMessage: true,
  disputeOpened: true,
  channels: ['email'],
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const prefs = await getPrefDelegate().findUnique({ where: { userId: user.id } })

    return NextResponse.json({ preferences: prefs ?? { ...DEFAULT_PREFS, userId: user.id } })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-b/notifications/preferences error')
    return NextResponse.json({ error: 'Failed to fetch notification preferences' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json().catch(() => null)) as Partial<NotificationPrefs> | null
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

    const boolFields = [
      'invoicePaid',
      'invoiceOverdue',
      'paymentFailed',
      'newMessage',
      'disputeOpened',
    ] as const
    const update: Partial<NotificationPrefs> = {}

    for (const field of boolFields) {
      if (field in body) {
        if (typeof body[field] !== 'boolean') {
          return NextResponse.json({ error: `${field} must be a boolean` }, { status: 400 })
        }
        update[field] = body[field] as boolean
      }
    }

    if ('channels' in body) {
      if (!Array.isArray(body.channels)) {
        return NextResponse.json({ error: 'channels must be an array' }, { status: 400 })
      }
      const invalid = body.channels.filter(
        (c): c is string => !VALID_CHANNELS.includes(c as Channel),
      )
      if (invalid.length > 0) {
        return NextResponse.json(
          { error: `invalid channels: ${invalid.join(', ')}. Must be one of: ${VALID_CHANNELS.join(', ')}` },
          { status: 400 },
        )
      }
      update.channels = body.channels as Channel[]
    }

    const preferences = await getPrefDelegate().upsert({
      where: { userId: user.id },
      update,
      create: { userId: user.id, ...DEFAULT_PREFS, ...update },
    })

    return NextResponse.json({ preferences })
  } catch (error) {
    logger.error({ err: error }, 'PATCH /api/routes-b/notifications/preferences error')
    return NextResponse.json({ error: 'Failed to update notification preferences' }, { status: 500 })
  }
}
