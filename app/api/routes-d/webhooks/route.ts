import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import {
  buildWebhookPostIdempotencyKey,
  getIdempotentResponse,
  setIdempotentResponse,
} from '../_lib/idempotency'

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
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000

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

    const idempotencyKey = request.headers.get('idempotency-key')?.trim() || null
    const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex')

    if (idempotencyKey) {
      const cached = getIdempotentResponse(
        buildWebhookPostIdempotencyKey(user.id, idempotencyKey),
      )
      if (cached) {
        if (cached.bodyHash !== bodyHash) {
          return NextResponse.json({ error: 'Idempotency conflict' }, { status: 409 })
        }
        return NextResponse.json(cached.body, { status: cached.status })
      }
    }

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

    const signingSecret = generateWebhookSecret()

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

    const responseBody = {
      id: webhook.id,
      targetUrl: webhook.targetUrl,
      description: webhook.description ?? null,
      signingSecret,
      createdAt: webhook.createdAt,
    }

    if (idempotencyKey) {
      setIdempotentResponse(
        buildWebhookPostIdempotencyKey(user.id, idempotencyKey),
        { bodyHash, status: 201, body: responseBody },
        IDEMPOTENCY_TTL_MS,
      )
    }

    return NextResponse.json(responseBody, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'Webhooks POST error')
    return NextResponse.json({ error: 'Failed to register webhook' }, { status: 500 })
  }
}
