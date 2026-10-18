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
  savingsLimitResponse,
  serializeSavingsGoal,
  type SavingsGoalRecord,
} from '@/app/api/_lib/savings-goals'

type RouteContext = { params: Promise<{ id: string }> }

const pauseSchema = z
  .object({
    isActive: z.boolean().optional(),
    paused: z.boolean().optional(),
  })
  .strict()

/**
 * Computes automatic percentage-based allocations across a user's savings goals.
 * Paused goals (`isActive: false`) and non-in-progress goals (`completed` or `withdrawn`)
 * are strictly excluded from automatic allocation.
 */
export function computeAutoAllocations(
  goals: SavingsGoalRecord[],
  incomingAmountInput: Decimal | number | string
) {
  const incomingAmount = new Decimal(incomingAmountInput)
  const eligibleGoals = goals.filter(
    (g) => g.isActive && g.status === GOAL_STATUS.IN_PROGRESS && g.savingsPercentage > 0
  )

  const allocations = eligibleGoals.map((goal) => {
    const rawShare = incomingAmount
      .times(goal.savingsPercentage)
      .dividedBy(100)
      .toDecimalPlaces(USDC_SCALE, Decimal.ROUND_HALF_UP)

    const remainingToTarget = Decimal.max(
      new Decimal(0),
      new Decimal(goal.targetAmountUsdc).minus(new Decimal(goal.currentAmountUsdc))
    )
    const allocatedAmount = Decimal.min(rawShare, remainingToTarget)

    return {
      goalId: goal.id,
      savingsPercentage: goal.savingsPercentage,
      allocatedAmountUsdc: allocatedAmount.toFixed(USDC_SCALE),
    }
  })

  const totalAllocated = allocations.reduce(
    (acc, item) => acc.plus(new Decimal(item.allocatedAmountUsdc)),
    new Decimal(0)
  )

  return {
    allocations,
    totalAllocatedUsdc: totalAllocated.toFixed(USDC_SCALE),
    excludedGoalIds: goals
      .filter((g) => !g.isActive || g.status !== GOAL_STATUS.IN_PROGRESS)
      .map((g) => g.id),
  }
}

/**
 * PATCH /api/savings-goals/[id]/pause
 *
 * Toggles (or explicitly sets) `isActive` on an `in_progress` savings goal
 * without discarding accumulated progress (`currentAmountUsdc`).
 * - Rejects toggling `isActive` on a goal whose `status` is `completed` or `withdrawn` (409).
 * - Excludes paused goals (`isActive: false`) from automatic percentage-based allocation.
 * - Records the timestamp of the pause or resume transition for audit purposes.
 */
export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const auth = await requireWalletActor(request)
    if ('response' in auth) return auth.response
    const { actor } = auth
    const { id } = await params

    let explicitIsActive: boolean | undefined
    const rawText = await request.text()
    if (rawText.trim().length > 0) {
      let rawJson: unknown
      try {
        rawJson = JSON.parse(rawText)
      } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
      }

      const parsed = pauseSchema.safeParse(rawJson)
      if (!parsed.success) {
        return NextResponse.json(
          { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
          { status: 400 }
        )
      }

      if (
        parsed.data.isActive !== undefined &&
        parsed.data.paused !== undefined &&
        parsed.data.isActive === parsed.data.paused
      ) {
        return NextResponse.json(
          { error: 'Conflicting isActive and paused values in request body' },
          { status: 400 }
        )
      }

      if (parsed.data.isActive !== undefined) {
        explicitIsActive = parsed.data.isActive
      } else if (parsed.data.paused !== undefined) {
        explicitIsActive = !parsed.data.paused
      }
    }

    const existingGoal = await findOwnedGoal(id, actor.id)
    if (!existingGoal) {
      return goalNotFoundResponse()
    }

    if (
      existingGoal.status === GOAL_STATUS.COMPLETED ||
      existingGoal.status === GOAL_STATUS.WITHDRAWN ||
      existingGoal.status !== GOAL_STATUS.IN_PROGRESS
    ) {
      return NextResponse.json(
        {
          error: `Cannot toggle pause state for a goal with status ${existingGoal.status}`,
          code: 'GOAL_NOT_IN_PROGRESS',
        },
        { status: 409 }
      )
    }

    const nextIsActive =
      explicitIsActive !== undefined ? explicitIsActive : !existingGoal.isActive
    const recordedAt = new Date()
    const action = nextIsActive ? 'resumed' : 'paused'

    const updatedGoal = await prisma.savingsGoal.update({
      where: { id },
      data: {
        isActive: nextIsActive,
        updatedAt: recordedAt,
      },
      select: SAVINGS_GOAL_SELECT,
    })

    const audit = {
      action,
      previousIsActive: existingGoal.isActive,
      isActive: updatedGoal.isActive,
      pausedAt: nextIsActive ? null : recordedAt.toISOString(),
      resumedAt: nextIsActive ? recordedAt.toISOString() : null,
      recordedAt: recordedAt.toISOString(),
    }

    logger.info(
      {
        goalId: id,
        userId: actor.id,
        action,
        previousIsActive: existingGoal.isActive,
        isActive: updatedGoal.isActive,
        currentAmountUsdc: new Decimal(updatedGoal.currentAmountUsdc).toFixed(USDC_SCALE),
        recordedAt: audit.recordedAt,
      },
      `Savings goal auto-allocation ${action}`
    )

    return NextResponse.json({
      goal: serializeSavingsGoal(updatedGoal),
      autoAllocationEligible:
        updatedGoal.isActive && updatedGoal.status === GOAL_STATUS.IN_PROGRESS,
      audit,
    })
  } catch (error) {
    if (isSavingsLimitError(error)) return savingsLimitResponse()
    logger.error({ err: error }, 'PATCH /api/savings-goals/[id]/pause error')
    return NextResponse.json(
      { error: 'Failed to update savings goal pause state' },
      { status: 500 }
    )
  }
}
