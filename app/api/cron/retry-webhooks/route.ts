import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { processPendingRetries } from '@/lib/webhooks'

/**
 * GET /api/cron/retry-webhooks
 * Safety-net sweep for webhook retries + cleanup of old delivery records.
 * Scheduled via Vercel Cron every 5 minutes.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    // Process any pending retries that QStash may have missed
    const retryResult = await processPendingRetries(50)

    // Cleanup: delete terminal delivery records older than 30 days.
    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

    const cleanedUp = await prisma.webhookDelivery.deleteMany({
      where: {
        status: { in: ['delivered', 'failed', 'exhausted'] },
        updatedAt: { lt: thirtyDaysAgo },
      },
    })

    return NextResponse.json({
      success: true,
      retries: {
        processed: retryResult.processed,
        delivered: retryResult.delivered,
        failed: retryResult.failed,
      },
      cleanedUp: cleanedUp.count,
    })
  } catch (error) {
    console.error('Fatal error in webhook retry cron:', error)
    return NextResponse.json(
      { error: 'Internal server error processing webhook retries' },
      { status: 500 }
    )
  }
}
