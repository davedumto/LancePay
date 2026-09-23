import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { logAuditEvent } from '@/lib/audit'

// POST /api/referral-earnings/[id]/clawback
// Reverses a ReferralEarning when the originating invoice is refunded or voided.

const CLAWBACK_EVENT_TYPE = 'referral_earning_clawed_back'

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { id } = await params
    if (!id || id.trim() === '') {
      return NextResponse.json({ error: 'Referral earning ID is required' }, { status: 400 })
    }

    const body = await request.json().catch(() => ({}))
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (!reason) {
      return NextResponse.json(
        { error: 'reason is required and must reference the triggering invoice event' },
        { status: 400 },
      )
    }
    // The invoice event (e.g. 'refund' or 'void') that triggered the clawback.
    const triggeringInvoiceEvent =
      typeof body.triggeringInvoiceEvent === 'string' ? body.triggeringInvoiceEvent.trim() : null
    const adminOverride = body.adminOverride === true

    const earning = await prisma.referralEarning.findFirst({
      where: { id, referrerId: user.id },
    })
    if (!earning) {
      return NextResponse.json({ error: 'Referral earning not found' }, { status: 404 })
    }

    if (earning.status === 'clawed_back') {
      return NextResponse.json(
        { error: 'Referral earning has already been clawed back' },
        { status: 409 },
      )
    }

    // A paid-out earning has already left the platform, so reversing it needs an
    // explicit admin override.
    if (earning.status === 'paid' && !adminOverride) {
      return NextResponse.json(
        {
          error: 'Cannot claw back a paid-out referral earning without an admin override',
          requiresAdminOverride: true,
        },
        { status: 409 },
      )
    }

    // The reversal must undo the full credit taken from the platform: the
    // referrer's amountUsdc plus the platformFee that was originally deducted.
    const reversedAmountUsdc = earning.amountUsdc
    const reversedPlatformFee = earning.platformFee
    const totalReversedUsdc = (
      Number(earning.amountUsdc) + Number(earning.platformFee)
    ).toFixed(6)

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.referralEarning.update({
        where: { id },
        data: {
          status: 'clawed_back',
          clawbackReason: reason,
          clawbackAt: new Date(),
        },
      })

      // Record the reversal against the originating invoice, referencing the
      // triggering event so the clawback is auditable end to end.
      await logAuditEvent(
        earning.invoiceId,
        CLAWBACK_EVENT_TYPE,
        user.id,
        {
          referralEarningId: earning.id,
          reason,
          triggeringInvoiceEvent,
          reversedAmountUsdc: String(reversedAmountUsdc),
          reversedPlatformFee: String(reversedPlatformFee),
          totalReversedUsdc,
          adminOverride,
        },
        tx,
      )

      return row
    })

    return NextResponse.json({
      referralEarning: {
        id: updated.id,
        status: updated.status,
        clawbackReason: updated.clawbackReason,
        clawbackAt: updated.clawbackAt,
      },
      reversal: {
        reversedAmountUsdc: String(reversedAmountUsdc),
        reversedPlatformFee: String(reversedPlatformFee),
        totalReversedUsdc,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/referral-earnings/[id]/clawback error')
    return NextResponse.json({ error: 'Failed to claw back referral earning' }, { status: 500 })
  }
}
