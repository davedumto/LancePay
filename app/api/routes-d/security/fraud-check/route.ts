import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { performFraudCheck, addToWatchlist, removeFromWatchlist, getWatchlist } from '@/lib/fraud'
import { logger } from '@/lib/logger'

const FraudCheckSchema = z.object({
  type: z.enum(['transaction', 'payout', 'user']),
  entityId: z.string().uuid(),
  metadata: z.object({
    ip: z.string().optional(),
    userAgent: z.string().optional(),
    email: z.string().email().optional(),
    userId: z.string().uuid().optional(),
    amount: z.number().positive().optional(),
  }),
})

const WatchlistSchema = z.object({
  action: z.enum(['add', 'remove', 'list']),
  type: z.enum(['ip', 'email_domain', 'country']).optional(),
  value: z.string().optional(),
  reason: z.string().optional(),
})

// Internal fraud check endpoint
export async function POST(request: NextRequest) {
  try {
    // Check for internal API key (simple auth for internal calls)
    const apiKey = request.headers.get('x-internal-api-key')
    const expectedKey = process.env.INTERNAL_API_KEY

    if (expectedKey && apiKey !== expectedKey) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const validationResult = FraudCheckSchema.safeParse(body)

    if (!validationResult.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validationResult.error.flatten().fieldErrors },
        { status: 400 }
      )
    }

    const { type, entityId, metadata } = validationResult.data

    const result = await performFraudCheck(type, entityId, metadata)

    return NextResponse.json({
      success: true,
      ...result,
    })
  } catch (error) {
    logger.error({ err: error }, 'Fraud check error:')
    return NextResponse.json({ error: 'Fraud check failed' }, { status: 500 })
  }
}

// Watchlist management endpoint
export async function PUT(request: NextRequest) {
  try {
    const apiKey = request.headers.get('x-internal-api-key')
    const expectedKey = process.env.INTERNAL_API_KEY

    if (expectedKey && apiKey !== expectedKey) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const validationResult = WatchlistSchema.safeParse(body)

    if (!validationResult.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validationResult.error.flatten().fieldErrors },
        { status: 400 }
      )
    }

    const { action, type, value, reason } = validationResult.data

    if (action === 'list') {
      const watchlist = await getWatchlist(type)
      return NextResponse.json({ success: true, watchlist })
    }

    if (!value) {
      return NextResponse.json({ error: 'Value is required for add/remove' }, { status: 400 })
    }

    if (action === 'add') {
      if (!type) {
        return NextResponse.json({ error: 'Type is required for add' }, { status: 400 })
      }
      const entry = await addToWatchlist(type, value, reason)
      return NextResponse.json({ success: true, entry })
    }

    if (action === 'remove') {
      await removeFromWatchlist(value)
      return NextResponse.json({ success: true, message: 'Removed from watchlist' })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    logger.error({ err: error }, 'Watchlist management error:')
    return NextResponse.json({ error: 'Watchlist operation failed' }, { status: 500 })
  }
}
