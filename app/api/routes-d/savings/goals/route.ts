import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import {
  getAuthContext,
  CreateSavingsGoalSchema,
  formatSavingsGoal,
  validateTotalSavingsPercentage,
} from '../_shared'

export async function GET(request: NextRequest) {
  try {
    const authResult = await getAuthContext(request)
    if ('error' in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: 401 })
    }

    const { user } = authResult

    const goals = await prisma.savingsGoal.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    })

    const activeGoals = goals.filter((g) => g.isActive && g.status === 'in_progress')
    const totalActivePercentage = activeGoals.reduce((sum, g) => sum + g.savingsPercentage, 0)

    return NextResponse.json({
      success: true,
      goals: goals.map(formatSavingsGoal),
      summary: {
        totalGoals: goals.length,
        activeGoals: activeGoals.length,
        totalActivePercentage,
        remainingPercentage: 50 - totalActivePercentage,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'Error fetching savings goals:')
    return NextResponse.json({ error: 'Failed to fetch savings goals' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const authResult = await getAuthContext(request)
    if ('error' in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: 401 })
    }

    const { user } = authResult
    const body = await request.json()
    const validationResult = CreateSavingsGoalSchema.safeParse(body)

    if (!validationResult.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validationResult.error.flatten().fieldErrors },
        { status: 400 }
      )
    }

    const { title, targetAmount, savingsPercentage } = validationResult.data

    const validation = await validateTotalSavingsPercentage(user.id, savingsPercentage)
    if (!validation.valid) {
      return NextResponse.json(
        { error: validation.error },
        { status: 400 }
      )
    }

    const goal = await prisma.savingsGoal.create({
      data: {
        userId: user.id,
        title,
        targetAmountUsdc: targetAmount,
        savingsPercentage,
      },
    })

    return NextResponse.json(
      { success: true, message: 'Savings goal created', goal: formatSavingsGoal(goal) },
      { status: 201 }
    )
  } catch (error) {
    logger.error({ err: error }, 'Error creating savings goal:')
    return NextResponse.json({ error: 'Failed to create savings goal' }, { status: 500 })
  }
}
