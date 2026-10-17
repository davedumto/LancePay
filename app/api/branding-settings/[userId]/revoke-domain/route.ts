import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const DEFAULT_SENDER_DOMAIN = process.env.DEFAULT_SENDER_DOMAIN?.trim() || 'lancepay.com'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const token = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(token)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const actor = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!actor) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { userId } = await params
    if (actor.id !== userId && actor.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden: domain owner or admin access required' }, { status: 403 })
    }

    const body = await request.json().catch(() => null)
    const reason = body?.revocationReason
    if (typeof reason !== 'string' || reason.trim() === '') {
      return NextResponse.json({ error: 'revocationReason is required' }, { status: 400 })
    }
    const trimmedReason = reason.trim()
    if (trimmedReason.length > 500) {
      return NextResponse.json({ error: 'revocationReason must be at most 500 characters' }, { status: 400 })
    }

    const revokedAt = new Date()
    const result = await prisma.brandingSettings.updateMany({
      where: {
        userId,
        customDomain: { not: null },
        verificationStatus: 'verified',
      },
      data: {
        customDomain: null,
        verificationToken: null,
        verificationStatus: 'unverified',
        verifiedAt: null,
        verificationAttempts: 0,
        senderDomain: DEFAULT_SENDER_DOMAIN,
        domainRevokedAt: revokedAt,
        domainRevocationReason: trimmedReason,
      },
    })
    if (result.count === 0) {
      return NextResponse.json({ error: 'Verified custom domain not found' }, { status: 404 })
    }

    return NextResponse.json({
      userId,
      senderDomain: DEFAULT_SENDER_DOMAIN,
      revokedAt,
      domainRevokedAt: revokedAt,
      revocationReason: trimmedReason,
      domainRevocationReason: trimmedReason,
      verificationStatus: 'unverified',
      customDomain: null,
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/branding-settings/[userId]/revoke-domain error')
    return NextResponse.json({ error: 'Failed to revoke custom domain' }, { status: 500 })
  }
}
