import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthContext, UpdateSavingsGoalSchema, formatSavingsGoal } from '../../_shared'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authResult = await getAuthContext(request)
    if ('error' in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: 401 })
    }

    const { user } = authResult
    const { id } = await params

    const goal = await prisma.savingsGoal.findFirst({
      where: { id, userId: user.id },
    })

    if (!goal) {
      return NextResponse.json({ error: 'Goal not found' }, { status: 404 })
    }

    return NextResponse.json({ success: true, goal: formatSavingsGoal(goal) })
  } catch (error) {
    console.error('Error fetching savings goal:', error)
    return NextResponse.json({ error: 'Failed to fetch savings goal' }, { status: 500 })
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authResult = await getAuthContext(request)
    if ('error' in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: 401 })
    }

    const { user } = authResult
    const { id } = await params
    const body = await request.json()
    const validationResult = UpdateSavingsGoalSchema.safeParse(body)

    if (!validationResult.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validationResult.error.flatten().fieldErrors },
        { status: 400 }
      )
    }

    const goal = await prisma.savingsGoal.findFirst({
      where: { id, userId: user.id },
    })

    if (!goal) {
      return NextResponse.json({ error: 'Goal not found' }, { status: 404 })
    }

    const { isActive, release } = validationResult.data

    // Handle release: move funds back to main balance
    if (release) {
      if (goal.status === 'released') {
        return NextResponse.json({ error: 'Goal funds already released' }, { status: 400 })
      }

      const updatedGoal = await prisma.savingsGoal.update({
        where: { id },
        data: {
          status: 'released',
          isActive: false,
        },
      })

      return NextResponse.json({
        success: true,
        message: `Released ${Number(goal.currentAmountUsdc).toFixed(2)} USDC back to main balance`,
        goal: formatSavingsGoal(updatedGoal),
      })
    }

    // Handle pause/resume
    if (isActive !== undefined) {
      // Check 50% limit when reactivating
      if (isActive && !goal.isActive) {
        const activeGoals = await prisma.savingsGoal.findMany({
          where: { userId: user.id, isActive: true, status: 'in_progress', id: { not: id } },
        })
        const currentTotal = activeGoals.reduce((sum, g) => sum + g.savingsPercentage, 0)

        if (currentTotal + goal.savingsPercentage > 50) {
          return NextResponse.json(
            { error: `Cannot reactivate: would exceed 50% limit (current: ${currentTotal}%)` },
            { status: 400 }
          )
        }
      }

      const updatedGoal = await prisma.savingsGoal.update({
        where: { id },
        data: { isActive },
      })

      return NextResponse.json({
        success: true,
        message: `Goal ${isActive ? 'resumed' : 'paused'} successfully`,
        goal: formatSavingsGoal(updatedGoal),
      })
    }

    return NextResponse.json({ error: 'No valid update provided' }, { status: 400 })
  } catch (error) {
    console.error('Error updating savings goal:', error)
    return NextResponse.json({ error: 'Failed to update savings goal' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authResult = await getAuthContext(request)
    if ('error' in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: 401 })
    }

    const { user } = authResult
    const { id } = await params

    const goal = await prisma.savingsGoal.findFirst({
      where: { id, userId: user.id },
    })

    if (!goal) {
      return NextResponse.json({ error: 'Goal not found' }, { status: 404 })
    }

    if (Number(goal.currentAmountUsdc) > 0 && goal.status !== 'released') {
      return NextResponse.json(
        { error: 'Cannot delete goal with unreleased funds. Release funds first.' },
        { status: 400 }
      )
    }

    await prisma.savingsGoal.delete({ where: { id } })

    return NextResponse.json({ success: true, message: 'Goal deleted successfully' })
  } catch (error) {
    console.error('Error deleting savings goal:', error)
    return NextResponse.json({ error: 'Failed to delete savings goal' }, { status: 500 })
  }
}
