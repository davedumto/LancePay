import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import {
  parseUsdcAmount,
  SAVINGS_GOAL_SELECT,
  serializeSavingsGoal,
  GOAL_STATUS,
} from '@/app/api/_lib/savings-goals'
import { Decimal } from '@prisma/client/runtime/library'

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { amount } = (body ?? {}) as { amount?: unknown }
    const incomingAmount = parseUsdcAmount(amount)
    if (!incomingAmount || incomingAmount.lte(0)) {
      return NextResponse.json(
        { error: 'amount must be a positive USDC amount' },
        { status: 400 },
      )
    }

    const goals = await prisma.savingsGoal.findMany({
      where: {
        userId: user.id,
        isActive: true,
        status: GOAL_STATUS.IN_PROGRESS,
      },
      select: SAVINGS_GOAL_SELECT,
    })

    if (goals.length === 0) {
      return NextResponse.json({
        allocatedTotal: '0.000000',
        allocations: [],
        goals: [],
      })
    }

    // Sum savingsPercentage across active goals
    const totalPercentage = goals.reduce((sum, g) => sum + g.savingsPercentage, 0)
    // Rule: If totalPercentage > 100, scale down proportionally so we never allocate more than 100% of the incoming amount
    const scaleFactor = totalPercentage > 100 ? 100 / totalPercentage : 1

    const updatedGoals = await prisma.$transaction(async (tx) => {
      const results = []

      for (const goal of goals) {
        const effectivePercentage = goal.savingsPercentage * scaleFactor
        const allocatedDecimal = incomingAmount.mul(new Decimal(effectivePercentage)).div(new Decimal(100))
        const newCurrent = new Decimal(goal.currentAmountUsdc).add(allocatedDecimal)

        const isCompleted = newCurrent.gte(goal.targetAmountUsdc)
        const updated = await tx.savingsGoal.update({
          where: { id: goal.id },
          data: {
            currentAmountUsdc: newCurrent,
            status: isCompleted ? GOAL_STATUS.COMPLETED : goal.status,
          },
          select: SAVINGS_GOAL_SELECT,
        })

        results.push({
          goalId: goal.id,
          allocatedAmount: allocatedDecimal.toFixed(6),
          percentage: goal.savingsPercentage,
          effectivePercentage,
          goal: serializeSavingsGoal(updated),
        })
      }

      return results
    })

    const totalAllocated = updatedGoals
      .reduce((sum, item) => sum.add(new Decimal(item.allocatedAmount)), new Decimal(0))
      .toFixed(6)

    return NextResponse.json({
      allocatedTotal: totalAllocated,
      allocations: updatedGoals,
      goals: updatedGoals.map((u) => u.goal),
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/savings-goals/auto-allocate error')
    return NextResponse.json({ error: 'Failed to auto-allocate savings' }, { status: 500 })
  }
}
