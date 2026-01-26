import { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

/**
 * Get authenticated user context from request
 */
export async function getAuthContext(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return { error: 'Unauthorized' as const }

  const claims = await verifyAuthToken(authToken)
  if (!claims) return { error: 'Invalid token' as const }

  let user = await prisma.user.findUnique({ 
    where: { privyId: claims.userId },
    include: {
      bankAccounts: true,
    }
  })
  
  if (!user) {
    const email = (claims as { email?: string }).email || `${claims.userId}@privy.local`
    user = await prisma.user.create({ 
      data: { privyId: claims.userId, email },
      include: {
        bankAccounts: true,
      }
    })
  }

  const email = ((claims as { email?: string }).email as string | undefined) || user.email
  return { user, claims, email }
}

/**
 * Schema for creating/updating auto-swap rules
 */
export const AutoSwapRuleSchema = z.object({
  percentage: z.number()
    .int('Percentage must be a whole number')
    .min(1, 'Percentage must be at least 1%')
    .max(100, 'Percentage cannot exceed 100%'),
  bankAccountId: z.string().uuid('Invalid bank account ID'),
  isActive: z.boolean().optional().default(true),
})

/**
 * Schema for updating auto-swap rule status only
 */
export const AutoSwapRuleStatusSchema = z.object({
  isActive: z.boolean(),
})

export type AutoSwapRuleInput = z.infer<typeof AutoSwapRuleSchema>
export type AutoSwapRuleStatusInput = z.infer<typeof AutoSwapRuleStatusSchema>

/**
 * Format auto-swap rule for API response
 */
export function formatAutoSwapRule(rule: {
  id: string
  userId: string
  percentage: number
  bankAccountId: string
  isActive: boolean
  createdAt: Date
  updatedAt: Date
  bankAccount?: {
    id: string
    bankName: string
    accountNumber: string
    accountName: string
  } | null
}) {
  return {
    id: rule.id,
    percentage: rule.percentage,
    bankAccountId: rule.bankAccountId,
    isActive: rule.isActive,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
    bankAccount: rule.bankAccount ? {
      id: rule.bankAccount.id,
      bankName: rule.bankAccount.bankName,
      accountNumber: rule.bankAccount.accountNumber,
      accountName: rule.bankAccount.accountName,
    } : null,
  }
}

