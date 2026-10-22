import { NextRequest, NextResponse } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { requireWalletActor } from '@/app/api/_lib/collective-wallet-auth'
import {
  GOAL_STATUS,
  SAVINGS_GOAL_SELECT,
  TAX_VAULT_EARLY_WITHDRAWAL_PENALTY_PERCENT,
  USDC_SCALE,
  findOwnedGoal,
  goalNotFoundResponse,
  parseUsdcAmount,
  serializeSavingsGoal,
  type SavingsGoalRecord,
} from '@/app/api/_lib/savings-goals'

type RouteContext = { params: Promise<{ id: string }> }

const withdrawSchema = z.object({
  amountUsdc: z.union([z.number(), z.string()]),
})

type WithdrawResult = { goal: SavingsGoalRecord; penaltyApplies: boolean } | { rejected: true }

/**
 * POST /api/savings-goals/[id]/withdraw
 * Withdraw from a goal's currentAmountUsdc.
 *
 * The decrement is guarded in the database (currentAmountUsdc >= amount), so
 * concurrent withdrawals can never take the balance negative. Withdrawing from
 * a tax vault goal that is still in_progress incurs an early-withdrawal penalty
 * that is disclosed in the response. The goal moves to withdrawn only once its
 * balance reaches zero.
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const auth = await requireWalletActor(request)
    if ('response' in auth) return auth.response
    const { actor } = auth
    const { id } = await params

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = withdrawSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      )
    }

    const amount = parseUsdcAmount(parsed.data.amountUsdc)
    if (!amount) {
      return NextResponse.json(
        { error: 'amountUsdc must be a positive amount with at most 6 decimal places' },
        { status: 400 }
      )
    }

    const result = await prisma.$transaction(async (tx): Promise<WithdrawResult> => {
      const decremented = await tx.savingsGoal.updateMany({
        where: { id, userId: actor.id, currentAmountUsdc: { gte: amount } },
        data: { currentAmountUsdc: { decrement: amount } },
      })
      if (decremented.count === 0) return { rejected: true }

      // Status is unchanged by the decrement, so it still reflects the goal's
      // state at the time of this withdrawal.
      const goal = await tx.savingsGoal.findUniqueOrThrow({
        where: { id },
        select: SAVINGS_GOAL_SELECT,
      })
      const penaltyApplies = goal.isTaxVault && goal.status === GOAL_STATUS.IN_PROGRESS

      if (!new Decimal(goal.currentAmountUsdc).eq(0)) {
        return { goal, penaltyApplies }
      }

      const withdrawnGoal = await tx.savingsGoal.update({
        where: { id },
        data: { status: GOAL_STATUS.WITHDRAWN },
        select: SAVINGS_GOAL_SELECT,
      })
      return { goal: withdrawnGoal, penaltyApplies }
    })

    if ('rejected' in result) {
      const goal = await findOwnedGoal(id, actor.id)
      if (!goal) return goalNotFoundResponse()
      return NextResponse.json(
        {
          error: 'Withdrawal amount exceeds the goal balance',
          code: 'INSUFFICIENT_GOAL_BALANCE',
          details: {
            requestedAmountUsdc: amount.toFixed(USDC_SCALE),
            currentAmountUsdc: new Decimal(goal.currentAmountUsdc).toFixed(USDC_SCALE),
          },
        },
        { status: 422 }
      )
    }

    const penaltyPercentage = result.penaltyApplies ? TAX_VAULT_EARLY_WITHDRAWAL_PENALTY_PERCENT : 0
    const penaltyAmount = amount
      .times(penaltyPercentage)
      .dividedBy(100)
      .toDecimalPlaces(USDC_SCALE, Decimal.ROUND_HALF_UP)
    const netAmount = amount.minus(penaltyAmount)

    logger.info(
      {
        goalId: id,
        userId: actor.id,
        amountUsdc: amount.toFixed(USDC_SCALE),
        penaltyPercentage,
        status: result.goal.status,
      },
      'Savings goal withdrawal recorded'
    )

    return NextResponse.json({
      goal: serializeSavingsGoal(result.goal),
      withdrawal: {
        amountUsdc: amount.toFixed(USDC_SCALE),
        earlyWithdrawalPenalty: {
          applied: result.penaltyApplies,
          percentage: penaltyPercentage,
          amountUsdc: penaltyAmount.toFixed(USDC_SCALE),
        },
        netAmountUsdc: netAmount.toFixed(USDC_SCALE),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/savings-goals/[id]/withdraw error')
    return NextResponse.json({ error: 'Failed to process withdrawal' }, { status: 500 })
  }
}
