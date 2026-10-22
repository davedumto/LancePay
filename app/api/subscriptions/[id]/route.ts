import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { billingPeriodStart } from '@/lib/proration'

const SELECT_FIELDS = {
  id: true,
  userId: true,
  clientEmail: true,
  clientName: true,
  description: true,
  amount: true,
  currency: true,
  frequency: true,
  interval: true,
  status: true,
  nextGenerationDate: true,
  lastGeneratedAt: true,
  createdAt: true,
  updatedAt: true,
}

/**
 * GET /api/subscriptions/[id]
 * Fetch a single subscription by ID, restricted to the authenticated owner.
 * Includes current billing period information.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { id } = await params
    if (!id || !id.trim()) {
      return NextResponse.json({ error: 'Subscription ID is required' }, { status: 400 })
    }

    const subscription = await prisma.subscription.findFirst({
      where: { id, userId: user.id },
      select: SELECT_FIELDS,
    })

    if (!subscription) {
      // Return 404 for non-existent or non-owned subscriptions (not 403) to avoid leaking existence
      return NextResponse.json({ error: 'Subscription not found' }, { status: 404 })
    }

    // Calculate current billing period
    let billingPeriod = null
    if (subscription.status === 'active' && subscription.nextGenerationDate) {
      try {
        const periodEnd = subscription.nextGenerationDate
        const periodStart = billingPeriodStart(
          periodEnd,
          subscription.frequency,
          subscription.interval,
        )
        billingPeriod = {
          start: periodStart.toISOString(),
          end: periodEnd.toISOString(),
        }
      } catch {
        // If billing period calculation fails, still return the subscription
        // but without the billing period
        billingPeriod = null
      }
    }

    return NextResponse.json({
      subscription: {
        id: subscription.id,
        clientEmail: subscription.clientEmail,
        clientName: subscription.clientName,
        description: subscription.description,
        amount: Number(subscription.amount),
        currency: subscription.currency,
        frequency: subscription.frequency,
        interval: subscription.interval,
        status: subscription.status,
        billingPeriod,
        nextGenerationDate: subscription.nextGenerationDate?.toISOString() || null,
        lastGeneratedAt: subscription.lastGeneratedAt?.toISOString() || null,
        createdAt: subscription.createdAt.toISOString(),
        updatedAt: subscription.updatedAt.toISOString(),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/subscriptions/[id] error')
    return NextResponse.json({ error: 'Failed to fetch subscription' }, { status: 500 })
  }
}
