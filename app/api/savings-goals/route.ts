import { NextRequest, NextResponse } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { requireWalletActor } from '@/app/api/_lib/collective-wallet-auth'
import {
  GOAL_STATUS,
  SAVINGS_GOAL_SELECT,
  isSavingsLimitError,
  parseUsdcAmount,
  savingsLimitResponse,
  serializeSavingsGoal,
} from '@/app/api/_lib/savings-goals'

const amountInput = z.union([z.number(), z.string()])

const createSavingsGoalSchema = z.object({
  title: z.string().trim().min(1, 'title is required').max(100),
  targetAmountUsdc: amountInput,
  currentAmountUsdc: amountInput.optional(),
  savingsPercentage: z
    .number()
    .int('savingsPercentage must be an integer')
    .min(1, 'savingsPercentage must be between 1 and 100')
    .max(100, 'savingsPercentage must be between 1 and 100'),
  isTaxVault: z.boolean().optional(),
})

const STATUS_FILTERS = new Set<string>(Object.values(GOAL_STATUS))

/**
 * GET /api/savings-goals
 * List the authenticated user's savings goals, newest first.
 * Optional ?status=in_progress|completed|withdrawn filter.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await requireWalletActor(request)
    if ('response' in auth) return auth.response
    const { actor } = auth

    const status = request.nextUrl.searchParams.get('status')
    if (status !== null && !STATUS_FILTERS.has(status)) {
      return NextResponse.json(
        { error: `status must be one of: ${[...STATUS_FILTERS].join(', ')}` },
        { status: 400 }
      )
    }

    const goals = await prisma.savingsGoal.findMany({
      where: { userId: actor.id, ...(status ? { status } : {}) },
      select: SAVINGS_GOAL_SELECT,
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({ goals: goals.map(serializeSavingsGoal) })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/savings-goals error')
    return NextResponse.json({ error: 'Failed to retrieve savings goals' }, { status: 500 })
  }
}

/**
 * POST /api/savings-goals
 * Create a savings goal. New goals always start active and in_progress; the
 * database trigger caps a user's active goals at 50% savingsPercentage total.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await requireWalletActor(request)
    if ('response' in auth) return auth.response
    const { actor } = auth

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = createSavingsGoalSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      )
    }

    const targetAmountUsdc = parseUsdcAmount(parsed.data.targetAmountUsdc)
    if (!targetAmountUsdc) {
      return NextResponse.json(
        { error: 'targetAmountUsdc must be a positive amount with at most 6 decimal places' },
        { status: 400 }
      )
    }

    let currentAmountUsdc = new Decimal(0)
    if (parsed.data.currentAmountUsdc !== undefined) {
      const current = parseUsdcAmount(parsed.data.currentAmountUsdc, { allowZero: true })
      if (!current) {
        return NextResponse.json(
          { error: 'currentAmountUsdc must be a non-negative amount with at most 6 decimal places' },
          { status: 400 }
        )
      }
      if (targetAmountUsdc.lte(current)) {
        return NextResponse.json(
          { error: 'targetAmountUsdc must be greater than currentAmountUsdc' },
          { status: 400 }
        )
      }
      currentAmountUsdc = current
    }

    const goal = await prisma.savingsGoal.create({
      data: {
        userId: actor.id,
        title: parsed.data.title,
        targetAmountUsdc,
        currentAmountUsdc,
        savingsPercentage: parsed.data.savingsPercentage,
        isTaxVault: parsed.data.isTaxVault ?? false,
        isActive: true,
        status: GOAL_STATUS.IN_PROGRESS,
      },
      select: SAVINGS_GOAL_SELECT,
    })

    logger.info({ goalId: goal.id, userId: actor.id }, 'Savings goal created')

    return NextResponse.json({ goal: serializeSavingsGoal(goal) }, { status: 201 })
  } catch (error) {
    if (isSavingsLimitError(error)) return savingsLimitResponse()
    logger.error({ err: error }, 'POST /api/savings-goals error')
    return NextResponse.json({ error: 'Failed to create savings goal' }, { status: 500 })
  }
}
