import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import crypto from 'crypto'

/**
 * PATCH /api/user-webhooks/[id]/rotate-signing-secret
 *
 * Rotates a webhook's signing secret while keeping the previous secret valid
 * for a short overlap window so in-flight deliveries signed with the old secret
 * still verify.
 *
 * Overlap window representation:
 *   - `signingSecret`          -> the new secret (used for all future signing)
 *   - `previousSigningSecret`  -> the secret being replaced
 *   - `signingSecretExpiresAt` -> timestamp after which the previous secret is
 *                                 no longer accepted
 * Verification (see the deliveries/verify-signature endpoint) accepts either
 * the current secret or the previous secret while `now < signingSecretExpiresAt`.
 *
 * The new secret is generated with a CSPRNG and returned exactly once in this
 * response. It is never logged or echoed anywhere else.
 */

// Default overlap window during which the previous secret still verifies.
const DEFAULT_GRACE_WINDOW_MS = 24 * 60 * 60 * 1000 // 24 hours
const MAX_GRACE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export async function PATCH(
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

    // Allow the caller to configure the overlap window, within bounds.
    const body = await request.json().catch(() => ({} as Record<string, unknown>))
    let graceWindowMs = DEFAULT_GRACE_WINDOW_MS
    if (body && body.graceWindowMs !== undefined) {
      const parsed = Number(body.graceWindowMs)
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_GRACE_WINDOW_MS) {
        return NextResponse.json(
          { error: `graceWindowMs must be a number between 0 and ${MAX_GRACE_WINDOW_MS}` },
          { status: 400 },
        )
      }
      graceWindowMs = parsed
    }

    const webhook = await prisma.userWebhook.findUnique({ where: { id } })
    if (!webhook) return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })

    // Only the webhook owner may rotate their own signing secret.
    if (webhook.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const newSecret = crypto.randomBytes(32).toString('hex')
    const now = new Date()
    const expiresAt =
      graceWindowMs > 0 ? new Date(now.getTime() + graceWindowMs) : null

    await prisma.userWebhook.update({
      where: { id },
      data: {
        signingSecret: newSecret,
        // Preserve the outgoing secret for the overlap window. When the window
        // is zero the previous secret is dropped immediately.
        previousSigningSecret: expiresAt ? webhook.signingSecret : null,
        signingSecretExpiresAt: expiresAt,
      },
    })

    // Log the rotation event but never the secret itself.
    logger.info(
      { userId: user.id, webhookId: id, graceWindowMs },
      'Webhook signing secret rotated',
    )

    return NextResponse.json(
      {
        id,
        // The only place the new secret is ever surfaced.
        signingSecret: newSecret,
        previousSecretValidUntil: expiresAt ? expiresAt.toISOString() : null,
        rotatedAt: now.toISOString(),
      },
      { status: 200 },
    )
  } catch (error) {
    logger.error(
      { err: error },
      'PATCH /api/user-webhooks/[id]/rotate-signing-secret error',
    )
    return NextResponse.json({ error: 'Failed to rotate signing secret' }, { status: 500 })
  }
}
