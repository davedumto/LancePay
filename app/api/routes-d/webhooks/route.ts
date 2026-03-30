import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── GET /api/routes-d/webhooks — list registered webhook endpoints ────

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null

  const claims = await verifyAuthToken(authToken)
  if (!claims) return null

  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const webhooks = await prisma.userWebhook.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        targetUrl: true,
        description: true,
        isActive: true,
        subscribedEvents: true,
        status: true,
        lastTriggeredAt: true,
        createdAt: true,
        // signingSecret intentionally excluded
      },
    })

    return NextResponse.json({ webhooks })
  } catch (error) {
    logger.error({ err: error }, 'Webhooks GET error')
    return NextResponse.json({ error: 'Failed to get webhooks' }, { status: 500 })
  }
}

// ── POST /api/routes-d/webhooks — register a new webhook endpoint ─────

const MAX_WEBHOOKS_PER_USER = 10

function isValidHttpsUrl(url: string) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json()

    // Validate targetUrl
    if (!body.targetUrl || typeof body.targetUrl !== 'string') {
      return NextResponse.json({ error: 'targetUrl is required' }, { status: 400 })
    }

    if (body.targetUrl.length > 512 || !isValidHttpsUrl(body.targetUrl)) {
      return NextResponse.json({ error: 'targetUrl must be a valid https:// URL (max 512 chars)' }, { status: 400 })
    }

    // Validate description
    if (body.description !== undefined && body.description !== null) {
      if (typeof body.description !== 'string' || body.description.length > 100) {
        return NextResponse.json({ error: 'description must be a string of at most 100 characters' }, { status: 400 })
      }
    }

    // Enforce max 10 webhooks per user
    const existingCount = await prisma.userWebhook.count({
      where: { userId: user.id },
    })

    if (existingCount >= MAX_WEBHOOKS_PER_USER) {
      return NextResponse.json(
        { error: 'Maximum of 10 webhooks per user reached' },
        { status: 429 },
      )
    }

    // Auto-generate signing secret
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
    logger.error({ err: error }, 'Webhooks POST error')
    return NextResponse.json({ error: 'Failed to register webhook' }, { status: 500 })
  }
}
