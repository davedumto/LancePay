import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

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
 * POST /api/subscriptions/[id]/cancel
 * Cancel a recurring subscription. Supports canceling immediately or at the end of the current billing period.
 * Rejects cancelling a subscription that is already cancelled.
 */
export async function POST(
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
      return NextResponse.json({ error: 'Subscription not found' }, { status: 404 })
    }

    // Check if already cancelled
    if (subscription.status === 'cancelled') {
      return NextResponse.json(
        {
          error: 'Subscription is already cancelled',
          subscription: {
            ...subscription,
            amount: Number(subscription.amount),
          },
        },
        { status: 409 },
      )
    }

    // Parse request body for cancellation option
    let body: any = {}
    try {
      body = await request.json()
    } catch {
      // No body provided, defaults to cancel immediately
    }

    const { cancelAtPeriodEnd = false } = body

    // Update subscription status
    const updatedSubscription = await prisma.subscription.update({
      where: { id },
      data: {
        status: 'cancelled',
        // If canceling at period end, keep nextGenerationDate as-is (last invoice will be generated)
        // If canceling immediately, set nextGenerationDate to past so no more invoices are generated
        ...(cancelAtPeriodEnd
          ? {}
          : { nextGenerationDate: new Date(0) }), // Epoch date ensures no future generation
      },
      select: SELECT_FIELDS,
    })

    logger.info(
      { userId: user.id, subscriptionId: id, cancelAtPeriodEnd },
      'Subscription cancelled',
    )

    return NextResponse.json({
      subscription: {
        ...updatedSubscription,
        amount: Number(updatedSubscription.amount),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/subscriptions/[id]/cancel error')
    return NextResponse.json({ error: 'Failed to cancel subscription' }, { status: 500 })
  }
}
