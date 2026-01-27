import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthContext } from '@/app/api/routes-d/disputes/_shared'
import { generateWebhookSecret } from '@/lib/webhooks'
import { z } from 'zod'

/**
 * Validation schema for creating a webhook
 */
const createWebhookSchema = z.object({
  targetUrl: z.string().url('Invalid URL format').max(512, 'URL too long'),
  events: z.array(z.string()).min(1, 'At least one event must be subscribed'),
  description: z.string().max(100).optional(),
})

/**
 * GET /api/routes-d/notifications/webhooks
 * List all webhooks for the authenticated user
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthContext(request)
    if ('error' in auth) {
      return NextResponse.json({ error: auth.error }, { status: 401 })
    }

    const webhooks = await prisma.userWebhook.findMany({
      where: { userId: auth.user.id },
      select: {
        id: true,
        targetUrl: true,
        description: true,
        isActive: true,
        subscribedEvents: true,
        lastTriggeredAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({ webhooks })
  } catch (error) {
    console.error('Webhooks GET error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch webhooks' },
      { status: 500 }
    )
  }
}

/**
 * POST /api/routes-d/notifications/webhooks
 * Create a new webhook configuration
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthContext(request)
    if ('error' in auth) {
      return NextResponse.json({ error: auth.error }, { status: 401 })
    }

    // Rate limit: Max 20 webhooks per user
    const webhookCount = await prisma.userWebhook.count({
      where: { userId: auth.user.id },
    })

    if (webhookCount >= 20) {
      return NextResponse.json(
        { error: 'Maximum of 20 webhooks allowed. Please delete some webhooks first.' },
        { status: 429 }
      )
    }

    // Validate request body
    const body = await request.json()
    const parsed = createWebhookSchema.safeParse(body)

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || 'Invalid request' },
        { status: 400 }
      )
    }

    // Validate event types
    const validEvents = [
      'invoice.paid',
      'invoice.viewed',
      'invoice.created',
      'invoice.disputed',
      'withdrawal.completed',
      'withdrawal.failed',
    ]

    const invalidEvents = parsed.data.events.filter(
      (event) => !validEvents.includes(event)
    )

    if (invalidEvents.length > 0) {
      return NextResponse.json(
        { error: `Invalid event types: ${invalidEvents.join(', ')}` },
        { status: 400 }
      )
    }

    // Generate signing secret
    const signingSecret = generateWebhookSecret()

    // Create webhook
    const webhook = await prisma.userWebhook.create({
      data: {
        userId: auth.user.id,
        targetUrl: parsed.data.targetUrl,
        signingSecret,
        description: parsed.data.description || null,
        subscribedEvents: parsed.data.events,
        isActive: true,
      },
      select: {
        id: true,
        targetUrl: true,
        description: true,
        isActive: true,
        subscribedEvents: true,
        createdAt: true,
      },
    })

    // Return webhook with secret ONLY ONCE
    return NextResponse.json(
      {
        message: 'Webhook created successfully. Save this secret securely - it will not be shown again.',
        webhook: {
          ...webhook,
          signingSecret, // Only time the secret is exposed
        },
      },
      { status: 201 }
    )
  } catch (error) {
    console.error('Webhook creation error:', error)
    return NextResponse.json(
      { error: 'Failed to create webhook' },
      { status: 500 }
    )
  }
}
