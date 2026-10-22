import { NextRequest, NextResponse } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { requireWalletActor } from '@/app/api/_lib/collective-wallet-auth'
import {
  GOAL_STATUS,
  SAVINGS_GOAL_SELECT,
  USDC_SCALE,
  findOwnedGoal,
  goalNotFoundResponse,
  isSavingsLimitError,
  parseUsdcAmount,
  savingsLimitResponse,
  serializeSavingsGoal,
  type SavingsGoalRecord,
} from '@/app/api/_lib/savings-goals'

type RouteContext = { params: Promise<{ id: string }> }

const contributeSchema = z.object({
  amountUsdc: z.union([z.number(), z.string()]),
})

type ContributeResult = { goal: SavingsGoalRecord; completed: boolean } | { rejected: true }

/**
 * POST /api/savings-goals/[id]/contribute
 * Add a manual contribution to an active, in-progress goal.
 *
 * The increment is applied in the database (not read-modify-write) so
 * concurrent contributions cannot lose updates. The row lock taken by that
 * UPDATE is held for the rest of the transaction, so exactly the contribution
 * that reaches targetAmountUsdc transitions the goal to completed.
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

    const parsed = contributeSchema.safeParse(body)
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

    const result = await prisma.$transaction(async (tx): Promise<ContributeResult> => {
      const incremented = await tx.savingsGoal.updateMany({
        where: { id, userId: actor.id, isActive: true, status: GOAL_STATUS.IN_PROGRESS },
        data: { currentAmountUsdc: { increment: amount } },
      })
      if (incremented.count === 0) return { rejected: true }

      const goal = await tx.savingsGoal.findUniqueOrThrow({
        where: { id },
        select: SAVINGS_GOAL_SELECT,
      })
      if (new Decimal(goal.currentAmountUsdc).lt(goal.targetAmountUsdc)) {
        return { goal, completed: false }
      }

      const completedGoal = await tx.savingsGoal.update({
        where: { id },
        data: { status: GOAL_STATUS.COMPLETED },
        select: SAVINGS_GOAL_SELECT,
      })
      return { goal: completedGoal, completed: true }
    })

    if ('rejected' in result) {
      const goal = await findOwnedGoal(id, actor.id)
      if (!goal) return goalNotFoundResponse()
      if (!goal.isActive) {
        return NextResponse.json(
          { error: 'Cannot contribute to an inactive savings goal', code: 'GOAL_INACTIVE' },
          { status: 409 }
        )
      }
      return NextResponse.json(
        {
          error: `Cannot contribute to a goal with status ${goal.status}`,
          code: 'GOAL_NOT_IN_PROGRESS',
        },
        { status: 409 }
      )
    }

    logger.info(
      { goalId: id, userId: actor.id, amountUsdc: amount.toFixed(USDC_SCALE), completed: result.completed },
      'Savings goal contribution recorded'
    )

    return NextResponse.json({
      goal: serializeSavingsGoal(result.goal),
      contribution: { amountUsdc: amount.toFixed(USDC_SCALE) },
      completed: result.completed,
    })
  } catch (error) {
    if (isSavingsLimitError(error)) return savingsLimitResponse()
    logger.error({ err: error }, 'POST /api/savings-goals/[id]/contribute error')
    return NextResponse.json({ error: 'Failed to record contribution' }, { status: 500 })
  }
}
