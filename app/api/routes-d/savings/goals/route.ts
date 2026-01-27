import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import {
  getAuthContext,
  CreateSavingsGoalSchema,
  formatSavingsGoal,
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
    console.error('Error fetching savings goals:', error)
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

    // Check total percentage across all active goals
    const activeGoals = await prisma.savingsGoal.findMany({
      where: { userId: user.id, isActive: true, status: 'in_progress' },
    })
    const currentTotal = activeGoals.reduce((sum, g) => sum + g.savingsPercentage, 0)

    if (currentTotal + savingsPercentage > 50) {
      return NextResponse.json(
        {
          error: `Cannot exceed 50% total savings. Current: ${currentTotal}%, Requested: ${savingsPercentage}%, Available: ${50 - currentTotal}%`,
        },
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
    console.error('Error creating savings goal:', error)
    return NextResponse.json({ error: 'Failed to create savings goal' }, { status: 500 })
  }
}
