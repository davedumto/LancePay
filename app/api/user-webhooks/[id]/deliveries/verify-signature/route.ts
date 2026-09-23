import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { computeWebhookSignature, signaturesMatch } from '@/lib/webhook-signature'

/**
 * GET /api/user-webhooks/[id]/deliveries/verify-signature
 *
 * Recomputes the HMAC-SHA256 signature for a stored delivery payload using the
 * webhook's signing secret and compares it, in constant time, against a
 * provided signature. Used for audit verification of what was actually sent.
 *
 * Query params:
 *   - deliveryId (required): the WebhookDelivery to verify
 *   - signature  (required): the signature to check, in `sha256=<hex>` form
 *
 * Access is restricted to the webhook owner or an admin. The raw signing secret
 * is never returned, only the verification result.
 *
 * If the webhook is mid-rotation (a previous secret is still within its grace
 * window) the payload is also checked against the previous secret so signatures
 * produced just before rotation still verify.
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

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { id } = await params
    const { searchParams } = new URL(request.url)
    const deliveryId = searchParams.get('deliveryId')
    const providedSignature = searchParams.get('signature')

    if (!deliveryId) {
      return NextResponse.json({ error: 'deliveryId is required' }, { status: 400 })
    }
    if (!providedSignature) {
      return NextResponse.json({ error: 'signature is required' }, { status: 400 })
    }

    const webhook = await prisma.userWebhook.findUnique({ where: { id } })
    if (!webhook) return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })

    // Only the webhook owner or an admin may verify signatures.
    if (webhook.userId !== user.id && user.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const delivery = await prisma.webhookDelivery.findUnique({ where: { id: deliveryId } })
    if (!delivery || delivery.webhookId !== id) {
      return NextResponse.json({ error: 'Delivery not found' }, { status: 404 })
    }

    const expectedCurrent = computeWebhookSignature(delivery.payload, webhook.signingSecret)
    let valid = signaturesMatch(expectedCurrent, providedSignature)
    let matchedSecret: 'current' | 'previous' | null = valid ? 'current' : null

    // Fall back to the previous secret while it is still within the grace window.
    const graceActive =
      !!webhook.previousSigningSecret &&
      !!webhook.signingSecretExpiresAt &&
      webhook.signingSecretExpiresAt.getTime() > Date.now()

    if (!valid && graceActive) {
      const expectedPrevious = computeWebhookSignature(
        delivery.payload,
        webhook.previousSigningSecret as string,
      )
      if (signaturesMatch(expectedPrevious, providedSignature)) {
        valid = true
        matchedSecret = 'previous'
      }
    }

    logger.info(
      { userId: user.id, webhookId: id, deliveryId, valid },
      'Webhook delivery signature verification performed',
    )

    return NextResponse.json(
      {
        webhookId: id,
        deliveryId,
        valid,
        matchedSecret,
        algorithm: 'HMAC-SHA256',
      },
      { status: 200 },
    )
  } catch (error) {
    logger.error(
      { err: error },
      'GET /api/user-webhooks/[id]/deliveries/verify-signature error',
    )
    return NextResponse.json({ error: 'Failed to verify signature' }, { status: 500 })
  }
}
