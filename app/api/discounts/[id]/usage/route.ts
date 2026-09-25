import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// GET /api/discounts/[id]/usage — report how many times a discount code has
// been successfully redeemed relative to its redemption limit.
//
// A redemption counts only when its DiscountRedemption status is "succeeded"
// and the invoice it was applied to has not since been voided. Pending,
// failed and rejected attempts never count.
//
// Discounts without maxRedemptions are unlimited: limit and remaining are
// null (never 0) and limitReached is always false.

const SUCCEEDED_STATUS = 'succeeded'
const VOIDED_INVOICE_STATUS = 'voided'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const discount = await prisma.discount.findFirst({
      where: { id, userId: user.id },
      select: { id: true, code: true, active: true, maxRedemptions: true },
    })

    if (!discount) {
      return NextResponse.json({ error: 'Discount not found' }, { status: 404 })
    }

    const redeemed = await prisma.discountRedemption.count({
      where: {
        discountId: discount.id,
        status: SUCCEEDED_STATUS,
        invoice: { status: { not: VOIDED_INVOICE_STATUS } },
      },
    })

    const limit = discount.maxRedemptions
    const limited = limit !== null

    return NextResponse.json({
      discountId: discount.id,
      code: discount.code,
      active: discount.active,
      limited,
      limit,
      redemptions: redeemed,
      remaining: limited ? Math.max(0, limit - redeemed) : null,
      limitReached: limited && redeemed >= limit,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/discounts/[id]/usage error')
    return NextResponse.json({ error: 'Failed to fetch discount usage' }, { status: 500 })
  }
}
