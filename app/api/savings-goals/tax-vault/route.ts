import { NextRequest, NextResponse } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { requireWalletActor } from '@/app/api/_lib/collective-wallet-auth'
import {
  SAVINGS_GOAL_SELECT,
  USDC_SCALE,
  serializeSavingsGoal,
} from '@/app/api/_lib/savings-goals'

/**
 * GET /api/savings-goals/tax-vault
 *
 * Surfaces the user's dedicated tax vault goal (`isTaxVault: true`) alongside
 * a projected tax liability estimate computed from currentAmountUsdc versus targetAmountUsdc.
 *
 * Rules:
 * - Returns 404 if no tax vault goal exists for the authenticated user.
 * - Handles the case of multiple tax vault goals defensively (returns the active / most recent one,
 *   with a multi-vault indicator and defensive aggregation).
 * - Computes projected liability estimate: targetAmountUsdc (projected tax due),
 *   currentAmountUsdc (accumulated tax reserve), remainingLiabilityUsdc, and fundingPercentage.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await requireWalletActor(request)
    if ('response' in auth) return auth.response
    const { actor } = auth

    // Find all tax vault goals for this user defensively
    const taxVaultGoals = await prisma.savingsGoal.findMany({
      where: {
        userId: actor.id,
        isTaxVault: true,
      },
      select: SAVINGS_GOAL_SELECT,
      orderBy: [
        { isActive: 'desc' },
        { createdAt: 'desc' },
      ],
    })

    if (taxVaultGoals.length === 0) {
      return NextResponse.json(
        {
          error: 'No tax vault goal configured for this account',
          code: 'TAX_VAULT_NOT_FOUND',
        },
        { status: 404 },
      )
    }

    if (taxVaultGoals.length > 1) {
      logger.warn(
        { userId: actor.id, count: taxVaultGoals.length },
        'Multiple tax vault goals found for user; prioritizing the active/primary goal',
      )
    }

    // Primary goal is the most recent active goal
    const primaryGoal = taxVaultGoals[0]!

    const targetDecimal = new Decimal(primaryGoal.targetAmountUsdc)
    const currentDecimal = new Decimal(primaryGoal.currentAmountUsdc)
    const remainingDecimal = Decimal.max(0, targetDecimal.sub(currentDecimal))

    const fundingRatio = targetDecimal.gt(0)
      ? currentDecimal.div(targetDecimal).mul(100).toNumber()
      : 100

    const projectedLiability = {
      projectedLiabilityUsdc: targetDecimal.toFixed(USDC_SCALE),
      currentAmountUsdc: currentDecimal.toFixed(USDC_SCALE),
      remainingLiabilityUsdc: remainingDecimal.toFixed(USDC_SCALE),
      fundingPercentage: Math.min(100, Math.max(0, Math.round(fundingRatio * 100) / 100)),
      isFullyFunded: currentDecimal.gte(targetDecimal),
    }

    return NextResponse.json({
      goal: serializeSavingsGoal(primaryGoal),
      projectedLiability,
      hasMultipleTaxVaults: taxVaultGoals.length > 1,
      totalTaxVaultCount: taxVaultGoals.length,
    }, { status: 200 })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/savings-goals/tax-vault error')
    return NextResponse.json(
      { error: 'Failed to retrieve tax vault goal' },
      { status: 500 },
    )
  }
}
