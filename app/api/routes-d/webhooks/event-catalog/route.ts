import { NextRequest, NextResponse } from 'next/server'
import { logger } from '../../_shared/logger'
import { getAuthenticatedUser } from '../../_shared/auth'
import { WEBHOOK_EVENT_CATALOG } from '../../_shared/webhook-events'

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    return NextResponse.json({
      eventTypes: WEBHOOK_EVENT_CATALOG,
      count: WEBHOOK_EVENT_CATALOG.length,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/webhooks/event-catalog error')
    return NextResponse.json({ error: 'Failed to list webhook events' }, { status: 500 })
  }
}
