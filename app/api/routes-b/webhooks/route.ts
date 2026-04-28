import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { withBodyLimit } from '../_lib/with-body-limit'

const MAX_WEBHOOKS_PER_USER = 10

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) {
    return null
  }

  const claims = await verifyAuthToken(authToken)
  if (!claims) {
    return null
  }

  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
}

function isValidHttpsUrl(url: string) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const webhooks = await prisma.userWebhook.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        targetUrl: true,
        description: true,
        isActive: true,
        subscribedEvents: true,
        lastTriggeredAt: true,
        createdAt: true,
      },
    })

    return NextResponse.json({ webhooks })
  } catch (error) {
    logger.error({ err: error }, 'Routes B webhooks GET error')
    return NextResponse.json({ error: 'Failed to get webhooks' }, { status: 500 })
  }
}

async function postWebhook(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()

    if (!body.targetUrl || typeof body.targetUrl !== 'string') {
      return NextResponse.json({ error: 'targetUrl is required' }, { status: 400 })
    }

    if (body.targetUrl.length > 512 || !isValidHttpsUrl(body.targetUrl)) {
      return NextResponse.json({ error: 'targetUrl must be a valid https:// URL (max 512 chars)' }, { status: 400 })
    }

    if (body.description !== undefined && body.description !== null) {
      if (typeof body.description !== 'string' || body.description.length > 100) {
        return NextResponse.json({ error: 'description must be a string of at most 100 characters' }, { status: 400 })
      }
    }

    const existingCount = await prisma.userWebhook.count({
      where: { userId: user.id },
    })

    if (existingCount >= MAX_WEBHOOKS_PER_USER) {
      return NextResponse.json(
        { error: 'Maximum of 10 webhooks per user reached' },
        { status: 429 },
      )
    }

    const signingSecret = crypto.randomBytes(32).toString('hex')

    const webhook = await prisma.userWebhook.create({
      data: {
        userId: user.id,
        targetUrl: body.targetUrl,
        description: body.description ?? null,
        signingSecret,
      },
      select: {
        id: true,
        targetUrl: true,
        description: true,
        createdAt: true,
      },
    })

    return NextResponse.json(
      {
        id: webhook.id,
        targetUrl: webhook.targetUrl,
        description: webhook.description ?? null,
        signingSecret,
        createdAt: webhook.createdAt,
      },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'Routes B webhooks POST error')
    return NextResponse.json({ error: 'Failed to register webhook' }, { status: 500 })
  }
}

export const POST = withBodyLimit(postWebhook, { limitBytes: 1024 * 1024 })
