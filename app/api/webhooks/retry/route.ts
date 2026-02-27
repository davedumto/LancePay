import { Receiver } from '@upstash/qstash'
import { NextResponse } from 'next/server'
import { processRetryDelivery } from '@/lib/webhooks'

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY || '',
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY || '',
})

/**
 * POST /api/webhooks/retry
 * QStash callback endpoint for webhook delivery retries.
 * Verifies QStash signature before processing.
 */
export async function POST(request: Request) {
  try {
    const body = await request.text()
    const signature = request.headers.get('upstash-signature')

    if (!signature) {
      return NextResponse.json({ error: 'Missing signature' }, { status: 401 })
    }

    const isValid = await receiver.verify({ signature, body })

    if (!isValid) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    const { deliveryId } = JSON.parse(body)

    if (!deliveryId) {
      return NextResponse.json({ error: 'Missing deliveryId' }, { status: 400 })
    }

    const success = await processRetryDelivery(deliveryId)

    return NextResponse.json({ success })
  } catch (error) {
    console.error('Webhook retry callback error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
