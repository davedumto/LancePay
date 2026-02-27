import { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

export async function getAuthContext(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return { error: 'Unauthorized' as const }

  const claims = await verifyAuthToken(authToken)
  if (!claims) return { error: 'Invalid token' as const }

  let user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
  })

  if (!user) {
    const email = (claims as { email?: string }).email || `${claims.userId}@privy.local`
    user = await prisma.user.create({
      data: { privyId: claims.userId, email },
    })
  }

  return { user, claims }
}

export const CreateSavingsGoalSchema = z.object({
  title: z.string().min(1, 'Title is required').max(100, 'Title too long'),
  targetAmount: z.number().positive('Target amount must be positive'),
  savingsPercentage: z.number()
    .int('Percentage must be a whole number')
    .min(1, 'Percentage must be at least 1%')
    .max(50, 'Single goal cannot exceed 50%'),
})

export const UpdateSavingsGoalSchema = z.object({
  isActive: z.boolean().optional(),
  release: z.boolean().optional(),
})

export type CreateSavingsGoalInput = z.infer<typeof CreateSavingsGoalSchema>
export type UpdateSavingsGoalInput = z.infer<typeof UpdateSavingsGoalSchema>

export async function validateTotalSavingsPercentage(
  userId: string,
  requestedPercentage: number,
  excludeGoalId?: string
): Promise<{ valid: boolean; currentTotal: number; error?: string }> {
  const activeGoals = await prisma.savingsGoal.findMany({
    where: {
      userId,
      isActive: true,
      status: 'in_progress',
      ...(excludeGoalId ? { id: { not: excludeGoalId } } : {}),
    },
    select: { savingsPercentage: true },
  })

  const currentTotal = activeGoals.reduce((sum, g) => sum + g.savingsPercentage, 0)
  const newTotal = currentTotal + requestedPercentage

  if (newTotal > 50) {
    return {
      valid: false,
      currentTotal,
      error: `Cannot exceed 50% total savings. Current: ${currentTotal}%, Requested: ${requestedPercentage}%, Available: ${50 - currentTotal}%`,
    }
  }

  return { valid: true, currentTotal }
}

export function formatSavingsGoal(goal: {
  id: string
  userId: string
  title: string
  targetAmountUsdc: unknown
  currentAmountUsdc: unknown
  savingsPercentage: number
  isActive: boolean
  status: string
  isTaxVault: boolean
  createdAt: Date
  updatedAt: Date
}) {
  const target = Number(goal.targetAmountUsdc)
  const current = Number(goal.currentAmountUsdc)
  const progressPercent = goal.isTaxVault
    ? null // tax vault has no target progress
    : target > 0 ? Math.min((current / target) * 100, 100) : 0

  return {
    id: goal.id,
    title: goal.title,
    targetAmountUsdc: goal.isTaxVault ? null : target,
    currentAmountUsdc: current,
    savingsPercentage: goal.savingsPercentage,
    isActive: goal.isActive,
    status: goal.status,
    isTaxVault: goal.isTaxVault,
    progressPercent: progressPercent !== null ? Math.round(progressPercent * 100) / 100 : null,
    createdAt: goal.createdAt.toISOString(),
    updatedAt: goal.updatedAt.toISOString(),
  }
}
