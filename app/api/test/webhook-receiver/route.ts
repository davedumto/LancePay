import { NextRequest, NextResponse } from 'next/server'
import { verifyWebhookSignature } from '@/lib/webhooks'

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

    console.log('\n📥 Webhook Received:')
    console.log(`   Event: ${eventType}`)
    console.log(`   Signature: ${signature?.substring(0, 20)}...`)
    console.log(`   Payload:`, JSON.stringify(payload, null, 2))

    // Note: In a real test, you'd verify the signature here
    // For now, we'll just log it

    return NextResponse.json({
      received: true,
      event: eventType,
      timestamp: new Date().toISOString(),
      message: 'Webhook received successfully',
    })
  } catch (error) {
    console.error('Webhook receiver error:', error)
    return NextResponse.json(
      { error: 'Failed to process webhook' },
      { status: 500 }
    )
  }
}
