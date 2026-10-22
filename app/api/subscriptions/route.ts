import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { createSubscriptionSchema } from '@/lib/validations'
import { logger } from '@/lib/logger'

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
      // monthly is default
      next.setMonth(next.getMonth() + interval)
  }
  return next
}

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1)
    const limit = Math.min(50, Math.max(1, parseInt(searchParams.get('limit') || '20', 10) || 20))

    if (status && !(VALID_STATUSES as readonly string[]).includes(status)) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
    }

    const where = {
      userId: user.id,
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
  } catch (error) {
    logger.error({ err: error }, 'GET /api/subscriptions error')
    return NextResponse.json({ error: 'Failed to fetch subscriptions' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

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
        userId: user.id,
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
  } catch (error) {
    logger.error({ err: error }, 'POST /api/subscriptions error')
    return NextResponse.json({ error: 'Failed to create subscription' }, { status: 500 })
  }
}
