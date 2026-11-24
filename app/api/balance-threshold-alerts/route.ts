import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const createAlertSchema = z
  .object({
    currency: z.string().trim().min(1).max(8).default('USD'),
    direction: z.enum(['below', 'above']),
    threshold: z.number().nonnegative(),
    enabled: z.boolean().optional(),
  })
  .strict()

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

const alertSelect = {
  id: true,
  currency: true,
  direction: true,
  threshold: true,
  enabled: true,
  lastTriggeredAt: true,
  createdAt: true,
} as const

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const alerts = await prisma.balanceThresholdAlert.findMany({
      where: { userId: user.id },
      select: alertSelect,
      orderBy: { createdAt: 'asc' },
    })
    return NextResponse.json({ alerts })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/balance-threshold-alerts error')
    return NextResponse.json({ error: 'Failed to fetch alerts' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    let body: unknown = {}
    const rawBody = await request.text()
    if (rawBody.trim()) {
      try {
        body = JSON.parse(rawBody)
      } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
      }
    }

    const parsed = createAlertSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      )
    }

    const alert = await prisma.balanceThresholdAlert.create({
      data: {
        userId: user.id,
        currency: parsed.data.currency,
        direction: parsed.data.direction,
        threshold: parsed.data.threshold,
        enabled: parsed.data.enabled ?? true,
      },
      select: alertSelect,
    })
    return NextResponse.json({ alert }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/balance-threshold-alerts error')
    return NextResponse.json({ error: 'Failed to create alert' }, { status: 500 })
  }
}
