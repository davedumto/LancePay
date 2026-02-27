import { NextRequest, NextResponse } from 'next/server'
import { verifyWebhookSignature } from '@/lib/webhooks'
import { logger } from '@/lib/logger'

/**
 * Test webhook receiver endpoint
 * This endpoint receives webhooks and logs them for testing
 */
export async function POST(request: NextRequest) {
  try {
    const signature = request.headers.get('X-LancePay-Signature')
    const eventType = request.headers.get('X-LancePay-Event')
    const body = await request.text()
    const payload = JSON.parse(body)

    logger.info('\n📥 Webhook Received:')
    logger.info(`   Event: ${eventType}`)
    logger.info(`   Signature: ${signature?.substring(0, 20)}...`)
    logger.info({ payload }, "   Payload:")

    // Note: In a real test, you'd verify the signature here
    // For now, we'll just log it

    return NextResponse.json({
      received: true,
      event: eventType,
      timestamp: new Date().toISOString(),
      message: 'Webhook received successfully',
    })
  } catch (error) {
    logger.error({ err: error }, 'Webhook receiver error:')
    return NextResponse.json(
      { error: 'Failed to process webhook' },
      { status: 500 }
    )
  }
}
