import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { requireWalletActor } from '@/app/api/_lib/collective-wallet-auth'
import {
  GOAL_STATUS,
  SAVINGS_GOAL_SELECT,
  findOwnedGoal,
  goalNotFoundResponse,
  serializeSavingsGoal,
} from '@/app/api/_lib/savings-goals'

type RouteContext = { params: Promise<{ id: string }> }

const pauseSchema = z
  .object({
    isActive: z.boolean().optional(),
  })
  .optional()

/**
 * PATCH /api/savings-goals/[id]/pause
 *
 * Pauses or resumes automatic allocation for a savings goal by toggling or
 * explicitly setting its `isActive` flag without discarding accumulated savings progress.
 *
 * Rules:
 * - Rejects toggling on goals that are already in `completed` or `withdrawn` status (400).
 * - Records audit log with timestamps for the state transition.
 * - Paused goals (`isActive = false`) are excluded from percentage-based allocation logic.
 */
export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const auth = await requireWalletActor(request)
    if ('response' in auth) return auth.response
    const { actor } = auth
    const { id } = await params

    const goal = await findOwnedGoal(id, actor.id)
    if (!goal) {
      return goalNotFoundResponse()
    }

    // Reject toggling isActive on a goal whose status is completed or withdrawn
    if (
      goal.status === GOAL_STATUS.COMPLETED ||
      goal.status === GOAL_STATUS.WITHDRAWN
    ) {
      return NextResponse.json(
        {
          error: `Cannot toggle pause state on a goal that is ${goal.status}`,
          code: 'INVALID_GOAL_STATUS',
        },
        { status: 400 },
      )
    }

    let targetActive: boolean
    try {
      const text = await request.text()
      if (text && text.trim().length > 0) {
        const body = JSON.parse(text)
        const parsed = pauseSchema.safeParse(body)
        if (parsed.success && typeof parsed.data?.isActive === 'boolean') {
          targetActive = parsed.data.isActive
        } else {
          targetActive = !goal.isActive
        }
      } else {
        targetActive = !goal.isActive
      }
    } catch {
      targetActive = !goal.isActive
    }

    const transitionTimestamp = new Date()
    const action = targetActive ? 'resume' : 'pause'

    const updated = await prisma.savingsGoal.update({
      where: { id: goal.id },
      data: {
        isActive: targetActive,
      },
      select: SAVINGS_GOAL_SELECT,
    })

    // Log the audit record with timestamp
    logger.info(
      {
        goalId: goal.id,
        userId: actor.id,
        previousIsActive: goal.isActive,
        currentIsActive: targetActive,
        action,
        timestamp: transitionTimestamp.toISOString(),
      },
      `Savings goal ${action}d successfully`,
    )

    return NextResponse.json({
      goal: serializeSavingsGoal(updated),
      action,
      actionTimestamp: transitionTimestamp.toISOString(),
      activeAllocationCounted: targetActive && updated.status === GOAL_STATUS.IN_PROGRESS,
    }, { status: 200 })
  } catch (error) {
    logger.error({ err: error }, 'PATCH /api/savings-goals/[id]/pause error')
    return NextResponse.json(
      { error: 'Failed to update savings goal pause state' },
      { status: 500 },
    )
  }
}
