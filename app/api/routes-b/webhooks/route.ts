import crypto from 'node:crypto'
import { withRequestId } from '../_lib/with-request-id'
import { withBodyLimit } from '../_lib/with-body-limit'
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

import {
  registerRoute,
} from '../_lib/openapi'

import {
  generateSecretFingerprint,
} from '../_lib/webhook-fingerprint'

import {
  generateWebhookSecret,
} from '../_lib/hmac'

import {
  getCustomHeaders,
  setCustomHeaders,
  validateCustomHeaders,
} from '../_lib/webhook-custom-headers'

import { z } from 'zod'

/* ---------------- OPENAPI ---------------- */

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
        createdAt: z.string(),
      })
    ),
  }),
  tags: ['webhooks'],
})

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
    createdAt: z.string(),
  }),
  tags: ['webhooks'],
})

/* ---------------- CONSTANTS ---------------- */

const MAX_WEBHOOKS_PER_USER = 10
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000

/* ---------------- AUTH ---------------- */

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers
    .get('authorization')
    ?.replace('Bearer ', '')

  if (!authToken) return null

  const claims = await verifyAuthToken(authToken)
  if (!claims) return null

  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
}

/* ---------------- HELPERS ---------------- */

function isValidHttpsUrl(url: string) {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

/* ---------------- GET ---------------- */

async function GETHandler(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
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

    const result = webhooks.map((w) => ({
      ...w,
      secretFingerprint: generateSecretFingerprint(w.signingSecret),
      signingSecret: undefined,
      headers: getCustomHeaders(w.id),
    }))

    return NextResponse.json({ webhooks: result })
  } catch (error) {
    logger.error({ err: error }, 'Routes B webhooks GET error')
    return NextResponse.json(
      { error: 'Failed to get webhooks' },
      { status: 500 }
    )
  }
}

/* ---------------- POST ---------------- */

async function POSTHandler(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const body = await request.json()
    const idempotencyKey =
      request.headers.get('idempotency-key')

    if (idempotencyKey && idempotencyKey.length > 255) {
      return NextResponse.json(
        { error: 'Idempotency-Key too long' },
        { status: 400 }
      )
    }

    const bodyHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(body))
      .digest('hex')

    // idempotency check
    if (idempotencyKey) {
      const cached = getIdempotentResponse(idempotencyKey)

      if (cached) {
        if (cached.bodyHash !== bodyHash) {
          return NextResponse.json(
            { error: 'Idempotency conflict' },
            { status: 409 }
          )
        }

        return NextResponse.json(cached.body, {
          status: cached.status,
        })
      }
    }

    if (
      !body.targetUrl ||
      typeof body.targetUrl !== 'string' ||
      !isValidHttpsUrl(body.targetUrl) ||
      body.targetUrl.length > 512
    ) {
      return NextResponse.json(
        { error: 'Invalid targetUrl' },
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
        {
          error:
            e instanceof Error ? e.message : 'Invalid eventTypes',
        },
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

    const count = await prisma.userWebhook.count({
      where: { userId: user.id },
    })

    if (count >= MAX_WEBHOOKS_PER_USER) {
      return NextResponse.json(
        { error: 'Webhook limit reached' },
        { status: 429 }
      )
    }

    const signingSecret =
      typeof body.signingSecret === 'string' &&
      body.signingSecret.trim()
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
    logger.error({ err: error }, 'Routes B webhooks POST error')
    return NextResponse.json(
      { error: 'Failed to register webhook' },
      { status: 500 }
    )
  }
}

/* ---------------- EXPORTS ---------------- */

export const GET = withRequestId(GETHandler)

export const POST = withRequestId(
  withBodyLimit(POSTHandler, {
    limitBytes: 1024 * 1024,
  })
)