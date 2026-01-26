import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import {
  calculateTrustScore,
  getTotalOutstandingAdvances,
  ELIGIBILITY_CRITERIA,
} from '@/lib/advance-eligibility'

/**
 * GET /api/routes-d/credit/eligibility
 * Check user's current eligibility status for payment advances
 */
export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers
      .get('authorization')
      ?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const trustScore = await calculateTrustScore(user.id)
    const outstandingAdvances = await getTotalOutstandingAdvances(user.id)

    const completedInvoices = await prisma.invoice.count({
      where: { userId: user.id, status: 'paid' },
    })

    const totalEarned = await prisma.transaction.aggregate({
      where: {
        userId: user.id,
        type: 'incoming',
        status: 'completed',
      },
      _sum: { amount: true },
    })

    const accountAgeDays = Math.floor(
      (Date.now() - user.createdAt.getTime()) / (1000 * 60 * 60 * 24)
    )

    const hasVerifiedBankAccount =
      (await prisma.bankAccount.count({
        where: { userId: user.id, isVerified: true },
      })) > 0

    return NextResponse.json({
      success: true,
      eligibility: {
        trustScore,
        completedInvoices,
        totalEarned: Number(totalEarned._sum.amount || 0),
        outstandingAdvances,
        availableCredit: Math.max(
          0,
          ELIGIBILITY_CRITERIA.MAX_OUTSTANDING_ADVANCES - outstandingAdvances
        ),
        accountAgeDays,
        hasVerifiedBankAccount,
        criteria: {
          minCompletedInvoices: ELIGIBILITY_CRITERIA.MIN_COMPLETED_INVOICES,
          minTotalEarned: ELIGIBILITY_CRITERIA.MIN_TOTAL_EARNED,
          minAccountAgeDays: ELIGIBILITY_CRITERIA.MIN_ACCOUNT_AGE_DAYS,
          maxAdvancePercentage: ELIGIBILITY_CRITERIA.MAX_ADVANCE_PERCENTAGE,
          advanceFeePercentage: ELIGIBILITY_CRITERIA.ADVANCE_FEE_PERCENTAGE,
        },
      },
    })
  } catch (error) {
    console.error('Eligibility check error:', error)
    return NextResponse.json(
      { error: 'Failed to check eligibility' },
      { status: 500 }
    )
  }
}
