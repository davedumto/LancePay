import crypto from 'node:crypto'
import { withRequestId } from '../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import {
  getIdempotentResponse,
  setIdempotentResponse,
} from '../_lib/idempotency'
import {
  validateEventTypes,
  getDefaultEventTypes,
} from '../_lib/webhook-events'
import { registerRoute } from '../_lib/openapi'
import { generateSecretFingerprint } from '../_lib/webhook-fingerprint'
import { generateWebhookSecret } from '../_lib/hmac'
import {
  getCustomHeaders,
  setCustomHeaders,
  validateCustomHeaders,
} from '../_lib/webhook-custom-headers'
import { z } from 'zod'

const MAX_WEBHOOKS_PER_USER = 10
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000

/**
 * OPENAPI - GET WEBHOOKS
 */
registerRoute({
  method: 'GET',
  path: '/webhooks',
  summary: 'List webhooks',
  description: 'Get all webhooks for the authenticated user.',
  responseSchema: z.object({
    webhooks: z.array(
      z.object({
        id: z.string(),
        targetUrl: z.string(),
        description: z.string().nullable(),
        isActive: z.boolean(),
        subscribedEvents: z.array(z.string()),
        lastTriggeredAt: z.string().nullable(),
        secretFingerprint: z.string(),
        headers: z.record(z.string(), z.string()).optional(),
        createdAt: z.string(),
      })
    ),
  }),
  tags: ['webhooks'],
})

/**
 * OPENAPI - CREATE WEBHOOK
 */
registerRoute({
  method: 'POST',
  path: '/webhooks',
  summary: 'Create webhook',
  description: 'Create a new webhook. Defaults to all events (*).',
  requestSchema: z.object({
    targetUrl: z.string().url(),
    description: z.string().max(100).optional(),
    eventTypes: z.array(z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
  responseSchema: z.object({
    id: z.string(),
    targetUrl: z.string(),
    description: z.string().nullable(),
    signingSecret: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    createdAt: z.string(),
  }),
  tags: ['webhooks'],
})

/**
 * AUTH
 */
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

function isValidHttpsUrl(url: string) {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * GET WEBHOOKS
 */
async function GETHandler(request: NextRequest) {
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
        signingSecret: true,
        createdAt: true,
      },
    })

    const webhooksWithFingerprint = webhooks.map((webhook) => ({
      ...webhook,
      secretFingerprint: generateSecretFingerprint(webhook.signingSecret),
      signingSecret: undefined,
      headers: getCustomHeaders(webhook.id),
    }))

    return NextResponse.json({ webhooks: webhooksWithFingerprint })
  } catch (error) {
    logger.error({ err: error }, 'GET webhooks error')
    return NextResponse.json(
      { error: 'Failed to get webhooks' },
      { status: 500 }
    )
  }
}

/**
 * CREATE WEBHOOK
 */
async function POSTHandler(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const idempotencyKey = request.headers.get('idempotency-key')

    const bodyHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(body))
      .digest('hex')

    if (idempotencyKey) {
      const cached = getIdempotentResponse(idempotencyKey)

      if (cached) {
        if (cached.bodyHash !== bodyHash) {
          return NextResponse.json(
            { error: 'Idempotency key reused with different body' },
            { status: 409 }
          )
        }

        return NextResponse.json(cached.body, { status: cached.status })
      }
    }

    if (!body.targetUrl || typeof body.targetUrl !== 'string') {
      return NextResponse.json(
        { error: 'targetUrl is required' },
        { status: 400 }
      )
    }

    if (body.targetUrl.length > 512 || !isValidHttpsUrl(body.targetUrl)) {
      return NextResponse.json(
        { error: 'Invalid HTTPS URL (max 512 chars)' },
        { status: 400 }
      )
    }

    if (
      body.description &&
      (typeof body.description !== 'string' || body.description.length > 100)
    ) {
      return NextResponse.json(
        { error: 'Invalid description' },
        { status: 400 }
      )
    }

    let eventTypes: string[]
    try {
      eventTypes = body.eventTypes
        ? validateEventTypes(body.eventTypes)
        : getDefaultEventTypes()
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'Invalid events' },
        { status: 400 }
      )
    }

    const headersResult = validateCustomHeaders(body.headers)
    if (!headersResult.ok) {
      return NextResponse.json(
        { error: headersResult.error },
        { status: 400 }
      )
    }

    const existingCount = await prisma.userWebhook.count({
      where: { userId: user.id },
    })

    if (existingCount >= MAX_WEBHOOKS_PER_USER) {
      return NextResponse.json(
        { error: 'Webhook limit reached (10)' },
        { status: 429 }
      )
    }

    const signingSecret =
      typeof body.signingSecret === 'string' && body.signingSecret.trim()
        ? body.signingSecret.trim()
        : generateWebhookSecret()

    const webhook = await prisma.userWebhook.create({
      data: {
        userId: user.id,
        targetUrl: body.targetUrl,
        description: body.description ?? null,
        signingSecret,
        subscribedEvents: eventTypes,
      },
      select: {
        id: true,
        targetUrl: true,
        description: true,
        createdAt: true,
      },
    })

    setCustomHeaders(webhook.id, headersResult.headers)

    const responseBody = {
      id: webhook.id,
      targetUrl: webhook.targetUrl,
      description: webhook.description ?? null,
      signingSecret,
      headers: headersResult.headers,
      createdAt: webhook.createdAt,
    }

    if (idempotencyKey) {
      setIdempotentResponse(
        idempotencyKey,
        {
          bodyHash,
          status: 201,
          body: responseBody,
        },
        IDEMPOTENCY_TTL_MS
      )
    }

    return NextResponse.json(responseBody, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST webhooks error')
    return NextResponse.json(
      { error: 'Failed to register webhook' },
      { status: 500 }
    )
  }
}

/**
 * EXPORT
 */
export const GET = withRequestId(GETHandler)
export const POST = withRequestId(POSTHandler)