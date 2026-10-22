import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const MAX_ENDPOINT_LENGTH = 2048
const MAX_KEY_LENGTH = 512

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
  return user ?? null
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

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
      new URL(endpoint)
    } catch {
      return NextResponse.json({ error: 'endpoint must be a valid URL' }, { status: 400 })
    }

    const keys = payload.keys
    if (typeof keys !== 'object' || keys === null || Array.isArray(keys)) {
      return NextResponse.json({ error: 'keys is required and must be an object' }, { status: 400 })
    }
    const { p256dh, auth } = keys as Record<string, unknown>

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

    const authKey = typeof auth === 'string' ? auth.trim() : null
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

    const existing = await prisma.pushSubscription.findUnique({ where: { endpoint } })
    if (existing && existing.userId !== user.id) {
      return NextResponse.json(
        { error: 'endpoint is registered to another user' },
        { status: 409 },
      )
    }

    const subscription = await prisma.pushSubscription.upsert({
      where: { endpoint },
      update: {
        userId: user.id,
        p256dh: p256dhKey,
        auth: authKey,
        userAgent,
        updatedAt: new Date(),
      },
      create: {
        userId: user.id,
        endpoint,
        p256dh: p256dhKey,
        auth: authKey,
        userAgent,
      },
      select: {
        id: true,
        endpoint: true,
        userAgent: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return NextResponse.json({ subscription }, { status: 200 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/push-subscriptions error')
    return NextResponse.json({ error: 'Failed to register push subscription' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const subscriptions = await prisma.pushSubscription.findMany({
      where: { userId: user.id },
      select: {
        id: true,
        endpoint: true,
        userAgent: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({ subscriptions })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/push-subscriptions error')
    return NextResponse.json({ error: 'Failed to fetch push subscriptions' }, { status: 500 })
  }
}
