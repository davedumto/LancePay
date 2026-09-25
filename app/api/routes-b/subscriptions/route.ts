import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { registerRoute } from '../_lib/openapi'
import { createSubscriptionSchema } from '@/lib/validations'
import { z } from 'zod'

registerRoute({
  method: 'GET',
  path: '/subscriptions',
  summary: 'List subscriptions',
  description: 'Get paginated recurring subscriptions for the authenticated user, optionally filtered by status.',
  requestSchema: z.object({
    status: z.enum(['active', 'paused', 'cancelled']).optional(),
    page: z.string().optional().default('1'),
    limit: z.string().optional().default('20'),
  }),
  responseSchema: z.object({
    subscriptions: z.array(
      z.object({
        id: z.string(),
        clientName: z.string().nullable(),
        clientEmail: z.string(),
        description: z.string(),
        amount: z.number(),
        currency: z.string(),
        frequency: z.string(),
        interval: z.number(),
        status: z.string(),
        nextGenerationDate: z.string(),
        lastGeneratedAt: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
    pagination: z.object({
      page: z.number(),
      limit: z.number(),
      total: z.number(),
      totalPages: z.number(),
    }),
  }),
  tags: ['subscriptions'],
})

registerRoute({
  method: 'POST',
  path: '/subscriptions',
  summary: 'Create subscription',
  description: 'Create a new recurring subscription that auto-generates invoices on the given schedule.',
  requestSchema: z.object({
    clientEmail: z.string().email(),
    clientName: z.string().optional(),
    description: z.string().min(1),
    amount: z.number().positive(),
    currency: z.string().optional().default('USD'),
    frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']).optional().default('monthly'),
    interval: z.number().int().positive().optional().default(1),
    startDate: z.string().optional(),
  }),
  responseSchema: z.object({
    id: z.string(),
    clientEmail: z.string(),
    clientName: z.string().nullable(),
    description: z.string(),
    amount: z.number(),
    currency: z.string(),
    frequency: z.string(),
    interval: z.number(),
    status: z.string(),
    nextGenerationDate: z.string(),
    createdAt: z.string(),
  }),
  tags: ['subscriptions'],
})

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return { error: NextResponse.json({ error: 'User not found' }, { status: 404 }) }
  }
  return { user }
}

const VALID_STATUSES = ['active', 'paused', 'cancelled'] as const

function computeNextGenerationDate(
  frequency: string,
  interval: number,
  from: Date,
): Date {
  const next = new Date(from)
  switch (frequency) {
    case 'daily':
      next.setDate(next.getDate() + interval)
      break
    case 'weekly':
      next.setDate(next.getDate() + interval * 7)
      break
    case 'yearly':
      next.setFullYear(next.getFullYear() + interval)
      break
    default:
      next.setMonth(next.getMonth() + interval)
  }
  return next
}

export async function GET(request: NextRequest) {
  const auth = await getAuthenticatedUser(request)
  if ('error' in auth) return auth.error

  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status')
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1)
  const limit = Math.min(50, Math.max(1, parseInt(searchParams.get('limit') || '20', 10) || 20))

  if (status && !(VALID_STATUSES as readonly string[]).includes(status)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
  }

  const where = {
    userId: auth.user.id,
    ...(status ? { status } : {}),
  }

  const [total, subscriptions] = await Promise.all([
    prisma.subscription.count({ where }),
    prisma.subscription.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        clientName: true,
        clientEmail: true,
        description: true,
        amount: true,
        currency: true,
        frequency: true,
        interval: true,
        status: true,
        nextGenerationDate: true,
        lastGeneratedAt: true,
        createdAt: true,
      },
    }),
  ])

  return NextResponse.json({
    subscriptions: subscriptions.map((s) => ({
      ...s,
      amount: Number(s.amount),
      nextGenerationDate: s.nextGenerationDate.toISOString(),
      lastGeneratedAt: s.lastGeneratedAt?.toISOString() ?? null,
      createdAt: s.createdAt.toISOString(),
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  })
}

export async function POST(request: NextRequest) {
  const auth = await getAuthenticatedUser(request)
  if ('error' in auth) return auth.error

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = createSubscriptionSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const {
    clientEmail,
    clientName,
    description,
    amount: parsedAmount,
    currency = 'USD',
    frequency = 'monthly',
    interval: parsedInterval = 1,
    startDate,
  } = parsed.data

  let fromDate = new Date()
  if (startDate) {
    const parsedDate = new Date(startDate)
    if (Number.isNaN(parsedDate.getTime())) {
      return NextResponse.json({ error: 'startDate must be a valid ISO date string' }, { status: 400 })
    }
    fromDate = parsedDate
  }

  const nextGenerationDate = computeNextGenerationDate(frequency, parsedInterval, fromDate)

  const subscription = await prisma.subscription.create({
    data: {
      userId: auth.user.id,
      clientEmail: clientEmail.toLowerCase(),
      clientName: clientName ?? null,
      description,
      amount: parsedAmount,
      currency: currency.toUpperCase(),
      frequency,
      interval: parsedInterval,
      status: 'active',
      nextGenerationDate,
    },
  })

  return NextResponse.json(
    {
      id: subscription.id,
      clientEmail: subscription.clientEmail,
      clientName: subscription.clientName,
      description: subscription.description,
      amount: Number(subscription.amount),
      currency: subscription.currency,
      frequency: subscription.frequency,
      interval: subscription.interval,
      status: subscription.status,
      nextGenerationDate: subscription.nextGenerationDate.toISOString(),
      createdAt: subscription.createdAt.toISOString(),
    },
    { status: 201 },
  )
}
