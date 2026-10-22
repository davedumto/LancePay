import { NextResponse } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'
import { prisma } from '@/lib/db'

// SavingsGoal amounts are DECIMAL(18,6): six fractional digits (USDC precision).
export const USDC_SCALE = 6
export const MAX_USDC_AMOUNT = new Decimal('999999999999.999999')

const USDC_PATTERN = /^\d+(\.\d{1,6})?$/

export const GOAL_STATUS = {
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  WITHDRAWN: 'withdrawn',
} as const

/** Penalty applied when a tax vault goal is withdrawn from before it completes. */
export const TAX_VAULT_EARLY_WITHDRAWAL_PENALTY_PERCENT = 10

export const SAVINGS_GOAL_SELECT = {
  id: true,
  title: true,
  targetAmountUsdc: true,
  currentAmountUsdc: true,
  savingsPercentage: true,
  isActive: true,
  status: true,
  isTaxVault: true,
  createdAt: true,
  updatedAt: true,
} as const

export interface SavingsGoalRecord {
  id: string
  title: string
  targetAmountUsdc: Decimal
  currentAmountUsdc: Decimal
  savingsPercentage: number
  isActive: boolean
  status: string
  isTaxVault: boolean
  createdAt: Date
  updatedAt: Date
}

/**
 * Parses a client-supplied USDC amount (number or numeric string) into a
 * Decimal. Returns null for anything that is not a non-negative amount with at
 * most six decimal places that fits the column. Pass `allowZero: false` to
 * also reject zero.
 */
export function parseUsdcAmount(value: unknown, { allowZero = false } = {}): Decimal | null {
  let raw: string
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    raw = String(value)
  } else if (typeof value === 'string') {
    raw = value.trim()
  } else {
    return null
  }

  if (!USDC_PATTERN.test(raw)) return null

  const amount = new Decimal(raw)
  if (amount.lt(0) || (!allowZero && amount.eq(0)) || amount.gt(MAX_USDC_AMOUNT)) return null
  return amount
}

/** Amounts are serialized as fixed six-decimal strings so no precision is lost. */
export function serializeSavingsGoal(goal: SavingsGoalRecord) {
  return {
    ...goal,
    targetAmountUsdc: new Decimal(goal.targetAmountUsdc).toFixed(USDC_SCALE),
    currentAmountUsdc: new Decimal(goal.currentAmountUsdc).toFixed(USDC_SCALE),
  }
}

/**
 * The enforce_savings_limit trigger raises when a user's active, in-progress
 * goals would exceed 50% in total. Prisma surfaces it as a raw database error.
 */
export function isSavingsLimitError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Total active savings cannot exceed 50%')
}

export function savingsLimitResponse() {
  return NextResponse.json(
    {
      error: 'Total savingsPercentage across active goals cannot exceed 50%',
      code: 'SAVINGS_LIMIT_EXCEEDED',
    },
    { status: 422 }
  )
}

export function goalNotFoundResponse() {
  return NextResponse.json(
    { error: 'Savings goal not found', code: 'GOAL_NOT_FOUND' },
    { status: 404 }
  )
}

/** Loads a goal owned by the user; another user's goal is reported as not found. */
export async function findOwnedGoal(goalId: string, userId: string): Promise<SavingsGoalRecord | null> {
  return prisma.savingsGoal.findFirst({
    where: { id: goalId, userId },
    select: SAVINGS_GOAL_SELECT,
  })
}
