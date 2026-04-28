import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { validateEventTypes, getDefaultEventTypes } from '../_lib/webhook-events'
import { registerRoute } from '../_lib/openapi'
import { generateSecretFingerprint } from '../_lib/webhook-fingerprint'
import { generateWebhookSecret } from '../_lib/hmac'
import { z } from 'zod'

// Register OpenAPI documentation
registerRoute({
  method: 'GET',
  path: '/webhooks',
  summary: 'List webhooks',
  description: 'Get all webhooks for the authenticated user.',
  responseSchema: z.object({
    webhooks: z.array(z.object({
      id: z.string(),
      targetUrl: z.string(),
      description: z.string().nullable(),
      isActive: z.boolean(),
      subscribedEvents: z.array(z.string()),
      lastTriggeredAt: z.string().nullable(),
      secretFingerprint: z.string(),
      createdAt: z.string()
    }))
  }),
  tags: ['webhooks']
})

registerRoute({
  method: 'POST',
  path: '/webhooks',
  summary: 'Create webhook',
  description: 'Create a new webhook. Defaults to all events (*).',
  requestSchema: z.object({
    targetUrl: z.string().url(),
    description: z.string().max(100).optional(),
    eventTypes: z.array(z.string()).optional()
  }),
  responseSchema: z.object({
    id: z.string(),
    targetUrl: z.string(),
    description: z.string().nullable(),
    signingSecret: z.string(),
    createdAt: z.string()
  }),
  tags: ['webhooks']
})

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
        signingSecret: true,
        createdAt: true,
      },
    })

    const webhooksWithFingerprint = webhooks.map(webhook => ({
      ...webhook,
      secretFingerprint: generateSecretFingerprint(webhook.signingSecret),
      signingSecret: undefined, // Remove raw secret
    }))

    return NextResponse.json({ webhooks: webhooksWithFingerprint })
  } catch (error) {
    logger.error({ err: error }, 'Routes B webhooks GET error')
    return NextResponse.json({ error: 'Failed to get webhooks' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
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

    // Validate event types
    let eventTypes: string[]
    try {
      eventTypes = body.eventTypes 
        ? validateEventTypes(body.eventTypes)
        : getDefaultEventTypes()
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Invalid eventTypes' },
        { status: 400 }
      )
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

    const signingSecret =
      typeof body.signingSecret === 'string' && body.signingSecret.trim().length > 0
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