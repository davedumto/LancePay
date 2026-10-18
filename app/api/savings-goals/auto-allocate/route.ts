import { NextRequest, NextResponse } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { requireWalletActor } from '@/app/api/_lib/collective-wallet-auth'
import {
  GOAL_STATUS,
  SAVINGS_GOAL_SELECT,
  USDC_SCALE,
  parseUsdcAmount,
  serializeSavingsGoal,
  type SavingsGoalRecord,
} from '@/app/api/_lib/savings-goals'

export interface GoalAllocationResult {
  goalId: string
  title: string
  requestedPercentage: number
  effectivePercentage: number
  allocatedAmountUsdc: string
  completed: boolean
  goal: ReturnType<typeof serializeSavingsGoal>
}

/**
 * POST /api/savings-goals/auto-allocate
 * Runs percentage-based automatic allocation of an incoming USDC amount across
 * all of the authenticated user's active, in-progress savings goals.
 *
 * Over-100% Proportional Scaling Rule:
 * - Only goals with `isActive: true` and `status: 'in_progress'` are eligible.
 * - If the sum of `savingsPercentage` across eligible goals is <= 100%, each goal
 *   receives `incomingAmount * (savingsPercentage / 100)`.
 * - If the sum of `savingsPercentage` across eligible goals exceeds 100%, each
 *   goal's share is proportionally scaled down by `100 / totalPercentage`
 *   (i.e. `incomingAmount * (savingsPercentage / totalPercentage)` truncated to
 *   6 decimal places with ROUND_DOWN) so total allocations never exceed the
 *   incoming amount.
 * - Each affected goal's `currentAmountUsdc` is atomically incremented inside a
 *   single database transaction, and goals reaching `targetAmountUsdc` are
 *   transitioned to `status: 'completed'`.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await requireWalletActor(request)
    if ('response' in auth) return auth.response
    const { actor } = auth

    let body: Record<string, unknown>
    try {
      body = (await request.json()) as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const rawAmount =
      body?.amountUsdc ?? body?.incomingAmountUsdc ?? body?.amount
    const incomingAmount = parseUsdcAmount(rawAmount)
    if (!incomingAmount) {
      return NextResponse.json(
        {
          error:
            'amountUsdc must be a positive amount with at most 6 decimal places',
        },
        { status: 400 },
      )
    }

    const txResult = await prisma.$transaction(async (tx) => {
      const eligibleGoals = await tx.savingsGoal.findMany({
        where: {
          userId: actor.id,
          isActive: true,
          status: GOAL_STATUS.IN_PROGRESS,
        },
        select: SAVINGS_GOAL_SELECT,
        orderBy: { createdAt: 'asc' },
      })

      const validGoals = eligibleGoals.filter(
        (g) => g.isActive && g.status === GOAL_STATUS.IN_PROGRESS && g.savingsPercentage > 0,
      )

      const totalPercentage = validGoals.reduce(
        (sum, g) => sum + g.savingsPercentage,
        0,
      )

      const scaled = totalPercentage > 100
      const denominator = scaled ? new Decimal(totalPercentage) : new Decimal(100)

      const allocations: GoalAllocationResult[] = []
      let totalAllocated = new Decimal(0)

      for (const goal of validGoals) {
        const pctDecimal = new Decimal(goal.savingsPercentage)
        const rawShare = incomingAmount
          .mul(pctDecimal)
          .div(denominator)
          .toDecimalPlaces(USDC_SCALE, Decimal.ROUND_DOWN)

        if (rawShare.lte(0)) continue

        // Ensure cumulative rounding never exceeds incomingAmount
        const remainingCap = incomingAmount.minus(totalAllocated)
        const allocatedAmount = rawShare.gt(remainingCap) ? remainingCap : rawShare
        if (allocatedAmount.lte(0)) continue

        let updatedGoal: SavingsGoalRecord = await tx.savingsGoal.update({
          where: { id: goal.id },
          data: {
            currentAmountUsdc: { increment: allocatedAmount },
          },
          select: SAVINGS_GOAL_SELECT,
        })

        let completed = false
        if (
          new Decimal(updatedGoal.currentAmountUsdc).gte(
            updatedGoal.targetAmountUsdc,
          )
        ) {
          updatedGoal = await tx.savingsGoal.update({
            where: { id: goal.id },
            data: { status: GOAL_STATUS.COMPLETED },
            select: SAVINGS_GOAL_SELECT,
          })
          completed = true
        }

        totalAllocated = totalAllocated.plus(allocatedAmount)
        const effectivePercentage = scaled
          ? Number(((goal.savingsPercentage / totalPercentage) * 100).toFixed(4))
          : goal.savingsPercentage

        allocations.push({
          goalId: updatedGoal.id,
          title: updatedGoal.title,
          requestedPercentage: goal.savingsPercentage,
          effectivePercentage,
          allocatedAmountUsdc: allocatedAmount.toFixed(USDC_SCALE),
          completed,
          goal: serializeSavingsGoal(updatedGoal),
        })
      }

      return {
        allocations,
        totalAllocated,
        totalPercentage,
        scaled,
      }
    })

    const unallocatedRemainder = incomingAmount.minus(txResult.totalAllocated)

    logger?.info?.(
      {
        userId: actor.id,
        incomingAmountUsdc: incomingAmount.toFixed(USDC_SCALE),
        totalAllocatedUsdc: txResult.totalAllocated.toFixed(USDC_SCALE),
        goalCount: txResult.allocations.length,
        scaled: txResult.scaled,
      },
      'POST /api/savings-goals/auto-allocate completed',
    )

    return NextResponse.json({
      incomingAmountUsdc: incomingAmount.toFixed(USDC_SCALE),
      totalAllocatedUsdc: txResult.totalAllocated.toFixed(USDC_SCALE),
      unallocatedRemainderUsdc: unallocatedRemainder.toFixed(USDC_SCALE),
      totalRequestedPercentage: txResult.totalPercentage,
      scaled: txResult.scaled,
      scalingRule: txResult.scaled
        ? 'proportional_cap_100'
        : 'exact_percentage',
      allocations: txResult.allocations,
    })
  } catch (error) {
    logger?.error?.({ err: error }, 'POST /api/savings-goals/auto-allocate error')
    return NextResponse.json(
      { error: 'Failed to auto-allocate savings goals' },
      { status: 500 },
    )
  }
}
