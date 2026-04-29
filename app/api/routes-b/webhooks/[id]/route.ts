import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { validateEventTypes } from '../../_lib/webhook-events'
import { registerRoute } from '../../_lib/openapi'
import { generateSecretFingerprint } from '../../_lib/webhook-fingerprint'
import {
  clearCustomHeaders,
  getCustomHeaders,
  setCustomHeaders,
  validateCustomHeaders,
} from '../../_lib/webhook-custom-headers'
import { z } from 'zod'

// Register OpenAPI documentation
registerRoute({
  method: 'GET',
  path: '/webhooks/{id}',
  summary: 'Get webhook',
  description: 'Get a specific webhook by ID.',
  responseSchema: z.object({
    webhook: z.object({
      id: z.string(),
      targetUrl: z.string(),
      description: z.string().nullable(),
      subscribedEvents: z.array(z.string()),
      isActive: z.boolean(),
      secretFingerprint: z.string(),
      createdAt: z.string()
    })
  }),
  tags: ['webhooks']
})

registerRoute({
  method: 'PATCH',
  path: '/webhooks/{id}',
  summary: 'Update webhook',
  description: 'Update webhook properties including event types.',
  requestSchema: z.object({
    targetUrl: z.string().url().optional(),
    description: z.string().max(100).optional(),
    eventTypes: z.array(z.string()).optional(),
    isActive: z.boolean().optional(),
    headers: z.record(z.string(), z.string()).nullable().optional()
  }),
  responseSchema: z.object({
    webhook: z.object({
      id: z.string(),
      targetUrl: z.string(),
      description: z.string().nullable(),
      subscribedEvents: z.array(z.string()),
      isActive: z.boolean(),
      createdAt: z.string(),
      updatedAt: z.string()
    })
  }),
  tags: ['webhooks']
})

registerRoute({
  method: 'DELETE',
  path: '/webhooks/{id}',
  summary: 'Delete webhook',
  description: 'Delete a webhook by ID.',
  tags: ['webhooks']
})

function isValidHttpsUrl(url: string) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:'
  } catch {
    return false
  }
}

async function GETHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const webhook = await prisma.userWebhook.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      targetUrl: true,
      description: true,
      subscribedEvents: true,
      isActive: true,
      signingSecret: true,
      createdAt: true,
    },
  })

  if (!webhook) {
    return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
  }

  if (webhook.userId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  return NextResponse.json({
    webhook: {
      id: webhook.id,
      targetUrl: webhook.targetUrl,
      description: webhook.description,
      subscribedEvents: webhook.subscribedEvents,
      isActive: webhook.isActive,
      secretFingerprint: generateSecretFingerprint(webhook.signingSecret),
      headers: getCustomHeaders(webhook.id),
      createdAt: webhook.createdAt,
    },
  })
}

async function PATCHHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const webhook = await prisma.userWebhook.findUnique({ where: { id } })
  if (!webhook) {
    return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
  }

  if (webhook.userId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await request.json()
  const { targetUrl, description, eventTypes, isActive, headers } = body

  const updateData: any = {}
  let nextHeaders: Record<string, string> | undefined
  let headersChanged = false

  if (headers !== undefined) {
    headersChanged = true
    if (headers === null) {
      nextHeaders = {}
    } else {
      const headersResult = validateCustomHeaders(headers)
      if (!headersResult.ok) {
        return NextResponse.json({ error: headersResult.error }, { status: 400 })
      }
      nextHeaders = headersResult.headers
    }
  }

  if (targetUrl !== undefined) {
    if (typeof targetUrl !== 'string' || targetUrl.length > 512 || !isValidHttpsUrl(targetUrl)) {
      return NextResponse.json(
        { error: 'targetUrl must be a valid https:// URL (max 512 chars)' },
        { status: 400 }
      )
    }
    updateData.targetUrl = targetUrl
  }

  if (description !== undefined) {
    if (description !== null && (typeof description !== 'string' || description.length > 100)) {
      return NextResponse.json(
        { error: 'description must be a string of at most 100 characters or null' },
        { status: 400 }
      )
    }
    updateData.description = description
  }

  if (eventTypes !== undefined) {
    try {
      updateData.subscribedEvents = validateEventTypes(eventTypes)
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Invalid eventTypes' },
        { status: 400 }
      )
    }
  }

  if (isActive !== undefined) {
    if (typeof isActive !== 'boolean') {
      return NextResponse.json({ error: 'isActive must be a boolean' }, { status: 400 })
    }
    updateData.isActive = isActive
  }

  if (Object.keys(updateData).length === 0 && !headersChanged) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
  }

  const updatedWebhook =
    Object.keys(updateData).length > 0
      ? await prisma.userWebhook.update({
          where: { id },
          data: updateData,
          select: {
            id: true,
            targetUrl: true,
            description: true,
            subscribedEvents: true,
            isActive: true,
            createdAt: true,
            updatedAt: true,
          },
        })
      : await prisma.userWebhook.findUnique({
          where: { id },
          select: {
            id: true,
            targetUrl: true,
            description: true,
            subscribedEvents: true,
            isActive: true,
            createdAt: true,
            updatedAt: true,
          },
        })

  if (headersChanged && nextHeaders !== undefined) {
    setCustomHeaders(id, nextHeaders)
  }

  return NextResponse.json({
    webhook: {
      ...updatedWebhook,
      headers: getCustomHeaders(id),
    },
  })
}

async function DELETEHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const webhook = await prisma.userWebhook.findUnique({ where: { id } })
  if (!webhook) {
    return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
  }

  if (webhook.userId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  await prisma.userWebhook.delete({ where: { id } })
  clearCustomHeaders(id)

  return new NextResponse(null, { status: 204 })
}

export const GET = withRequestId(GETHandler)
export const PATCH = withRequestId(PATCHHandler)
export const DELETE = withRequestId(DELETEHandler)
