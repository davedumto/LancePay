import { NextRequest, NextResponse } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { requireWalletActor } from '@/app/api/_lib/collective-wallet-auth'
import {
  GOAL_STATUS,
  SAVINGS_GOAL_SELECT,
  TAX_VAULT_EARLY_WITHDRAWAL_PENALTY_PERCENT,
  USDC_SCALE,
  serializeSavingsGoal,
  type SavingsGoalRecord,
} from '@/app/api/_lib/savings-goals'

function pickPrimaryTaxVault(goals: SavingsGoalRecord[]): SavingsGoalRecord {
  const activeInProgress = goals.find(
    (g) => g.isActive && g.status === GOAL_STATUS.IN_PROGRESS
  )
  if (activeInProgress) return activeInProgress

  const inProgress = goals.find((g) => g.status === GOAL_STATUS.IN_PROGRESS)
  if (inProgress) return inProgress

  const activeAny = goals.find((g) => g.isActive)
  if (activeAny) return activeAny

  return goals[0]
}

export function computeLiabilityEstimate(
  currentAmountInput: Decimal,
  targetAmountInput: Decimal,
  status: string
) {
  const current = new Decimal(currentAmountInput)
  const target = new Decimal(targetAmountInput)
  const diff = target.minus(current)

  const shortfall = diff.gt(0) ? diff : new Decimal(0)
  const surplus = diff.lt(0) ? current.minus(target) : new Decimal(0)
  const isFullyFunded = current.gte(target)

  const fundingProgressPercent = target.gt(0)
    ? Number(
        Decimal.min(new Decimal(100), current.times(100).dividedBy(target)).toDecimalPlaces(
          2,
          Decimal.ROUND_HALF_UP
        )
      )
    : 0

  const earlyPenaltyApplies = status === GOAL_STATUS.IN_PROGRESS && !isFullyFunded
  const penaltyPercent = earlyPenaltyApplies ? TAX_VAULT_EARLY_WITHDRAWAL_PENALTY_PERCENT : 0
  const estimatedEarlyPenalty = current
    .times(penaltyPercent)
    .dividedBy(100)
    .toDecimalPlaces(USDC_SCALE, Decimal.ROUND_HALF_UP)
  const netAvailableAfterPenalty = current.minus(estimatedEarlyPenalty)

  return {
    projectedLiabilityUsdc: target.toFixed(USDC_SCALE),
    reservedAmountUsdc: current.toFixed(USDC_SCALE),
    shortfallUsdc: shortfall.toFixed(USDC_SCALE),
    surplusUsdc: surplus.toFixed(USDC_SCALE),
    fundingProgressPercent,
    isFullyFunded,
    earlyWithdrawalPenalty: {
      applies: earlyPenaltyApplies,
      percentage: penaltyPercent,
      estimatedPenaltyUsdc: estimatedEarlyPenalty.toFixed(USDC_SCALE),
      netAvailableUsdc: netAvailableAfterPenalty.toFixed(USDC_SCALE),
    },
  }
}

/**
 * GET /api/savings-goals/tax-vault
 *
 * Locates the authenticated user's tax vault savings goal (`isTaxVault: true`),
 * computes a projected tax liability estimate from `currentAmountUsdc` vs
 * `targetAmountUsdc`, and handles multiple tax vault goals defensively by
 * selecting the primary active vault while also exposing aggregate metrics.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await requireWalletActor(request)
    if ('response' in auth) return auth.response
    const { actor } = auth

    const taxVaultGoals = await prisma.savingsGoal.findMany({
      where: {
        userId: actor.id,
        isTaxVault: true,
      },
      select: SAVINGS_GOAL_SELECT,
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    })

    if (taxVaultGoals.length === 0) {
      return NextResponse.json(
        {
          error: 'Tax vault savings goal not found',
          code: 'TAX_VAULT_NOT_FOUND',
        },
        { status: 404 }
      )
    }

    const primaryGoal = pickPrimaryTaxVault(taxVaultGoals)
    const liabilityEstimate = computeLiabilityEstimate(
      primaryGoal.currentAmountUsdc,
      primaryGoal.targetAmountUsdc,
      primaryGoal.status
    )

    const multipleTaxVaults = taxVaultGoals.length > 1
    let aggregateEstimate = liabilityEstimate

    if (multipleTaxVaults) {
      const relevantGoals = taxVaultGoals.filter((g) => g.status !== GOAL_STATUS.WITHDRAWN)
      const pool = relevantGoals.length > 0 ? relevantGoals : taxVaultGoals

      const totalCurrent = pool.reduce(
        (acc, g) => acc.plus(new Decimal(g.currentAmountUsdc)),
        new Decimal(0)
      )
      const totalTarget = pool.reduce(
        (acc, g) => acc.plus(new Decimal(g.targetAmountUsdc)),
        new Decimal(0)
      )

      aggregateEstimate = computeLiabilityEstimate(
        totalCurrent,
        totalTarget,
        primaryGoal.status
      )
    }

    return NextResponse.json({
      taxVault: serializeSavingsGoal(primaryGoal),
      liabilityEstimate,
      multipleTaxVaults,
      taxVaultCount: taxVaultGoals.length,
      aggregateLiabilityEstimate: aggregateEstimate,
      allTaxVaults: taxVaultGoals.map(serializeSavingsGoal),
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/savings-goals/tax-vault error')
    return NextResponse.json(
      { error: 'Failed to retrieve tax vault summary' },
      { status: 500 }
    )
  }
}
