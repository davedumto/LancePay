import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const MAX_ENDPOINT_LENGTH = 2048
const MAX_KEY_LENGTH = 512

const SUBSCRIPTION_SELECT = {
  id: true,
  endpoint: true,
  userAgent: true,
  createdAt: true,
  updatedAt: true,
} as const

type PushSubscriptionDelegate = {
  findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>
  findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]>
  upsert: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

function getPushSubscriptionDelegate(): PushSubscriptionDelegate {
  return (prisma as unknown as { pushSubscription: PushSubscriptionDelegate }).pushSubscription
}

async function getAuthenticatedUserId(
  request: NextRequest,
): Promise<{ userId: string } | { response: NextResponse }> {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) {
    return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  const claims = await verifyAuthToken(authToken)
  if (!claims) {
    return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
  if (!user) {
    return { response: NextResponse.json({ error: 'User not found' }, { status: 404 }) }
  }
  return { userId: user.id }
}

/**
 * GET /api/push-subscriptions
 * Lists all active push notification subscriptions scoped to the authenticated user.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUserId(request)
    if ('response' in auth) return auth.response
    const { userId } = auth

    const delegate = getPushSubscriptionDelegate()
    const subscriptions = await delegate.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: SUBSCRIPTION_SELECT,
    })

    return NextResponse.json({ subscriptions }, { status: 200 })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/push-subscriptions error')
    return NextResponse.json(
      { error: 'Failed to fetch push subscriptions' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/push-subscriptions
 * Registers or updates a Web Push subscription (`endpoint`, `keys.p256dh`, `keys.auth`)
 * for the authenticated user, upserting on `endpoint` so re-registering the same
 * browser does not create duplicate rows.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUserId(request)
    if ('response' in auth) return auth.response
    const { userId } = auth

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const payload = (body ?? {}) as Record<string, unknown>

    const endpoint = typeof payload.endpoint === 'string' ? payload.endpoint.trim() : null
    if (!endpoint) {
      return NextResponse.json({ error: 'endpoint is required' }, { status: 400 })
    }
    if (endpoint.length > MAX_ENDPOINT_LENGTH) {
      return NextResponse.json(
        { error: `endpoint must be at most ${MAX_ENDPOINT_LENGTH} characters` },
        { status: 400 },
      )
    }
    try {
      const parsedUrl = new URL(endpoint)
      if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
        return NextResponse.json({ error: 'endpoint must be a valid HTTP/HTTPS URL' }, { status: 400 })
      }
    } catch {
      return NextResponse.json({ error: 'endpoint must be a valid URL' }, { status: 400 })
    }

    const keys = payload.keys
    if (typeof keys !== 'object' || keys === null || Array.isArray(keys)) {
      return NextResponse.json(
        { error: 'keys is required and must be an object' },
        { status: 400 },
      )
    }
    const { p256dh, auth: authSecret } = keys as Record<string, unknown>

    const p256dhKey = typeof p256dh === 'string' ? p256dh.trim() : null
    if (!p256dhKey) {
      return NextResponse.json({ error: 'keys.p256dh is required' }, { status: 400 })
    }
    if (p256dhKey.length > MAX_KEY_LENGTH) {
      return NextResponse.json(
        { error: `keys.p256dh must be at most ${MAX_KEY_LENGTH} characters` },
        { status: 400 },
      )
    }

    const authKey = typeof authSecret === 'string' ? authSecret.trim() : null
    if (!authKey) {
      return NextResponse.json({ error: 'keys.auth is required' }, { status: 400 })
    }
    if (authKey.length > MAX_KEY_LENGTH) {
      return NextResponse.json(
        { error: `keys.auth must be at most ${MAX_KEY_LENGTH} characters` },
        { status: 400 },
      )
    }

    const userAgent =
      typeof payload.userAgent === 'string' ? payload.userAgent.trim() || null : null

    const delegate = getPushSubscriptionDelegate()

    const existing = await delegate.findUnique({ where: { endpoint } })
    if (existing && (existing as { userId: string }).userId !== userId) {
      return NextResponse.json(
        { error: 'endpoint is registered to another user' },
        { status: 409 },
      )
    }

    const subscription = await delegate.upsert({
      where: { endpoint },
      update: {
        userId,
        p256dh: p256dhKey,
        auth: authKey,
        userAgent,
        updatedAt: new Date(),
      },
      create: {
        userId,
        endpoint,
        p256dh: p256dhKey,
        auth: authKey,
        userAgent,
      },
      select: SUBSCRIPTION_SELECT,
    })

    return NextResponse.json({ subscription }, { status: 200 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/push-subscriptions error')
    return NextResponse.json(
      { error: 'Failed to register push subscription' },
      { status: 500 },
    )
  }
}
