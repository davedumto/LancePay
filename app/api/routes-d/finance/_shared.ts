import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

/**
 * Finance module shared utilities
 * Fee rate constants (aligned with tax-reports module)
 */
export const PLATFORM_FEE_RATE = 0.005 // 0.5%
export const WITHDRAWAL_FEE_RATE = 0.005 // 0.5%

/**
 * Supported period types for P&L reports
 */
export type PeriodType = 'current_month' | 'last_month' | 'current_quarter' | 'last_year'

/**
 * Date range result
 */
export interface DateRange {
  start: Date
  end: Date
  label: string
}

/**
 * Authenticate user from request
 */
export async function getOrCreateUserFromRequest(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return { error: 'Unauthorized' as const }

  const claims = await verifyAuthToken(authToken)
  if (!claims) return { error: 'Invalid token' as const }

  let user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    const email = (claims as { email?: string }).email || `${claims.userId}@privy.local`
    user = await prisma.user.create({ data: { privyId: claims.userId, email } })
  }

  return { user }
}

/**
 * Calculate platform fee (0.5% of amount)
 */
export function computePlatformFee(amount: number): number {
  return round2(amount * PLATFORM_FEE_RATE)
}

/**
 * Calculate withdrawal fee (0.5% of amount)
 */
export function computeWithdrawalFee(amount: number): number {
  return round2(amount * WITHDRAWAL_FEE_RATE)
}

/**
 * Round to 2 decimal places (avoid floating point errors)
 */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/**
 * Parse period parameter and return date range
 */
export function getPeriodDateRange(period: string): DateRange | null {
  const now = new Date()
  const currentYear = now.getUTCFullYear()
  const currentMonth = now.getUTCMonth() // 0-indexed

  switch (period) {
    case 'current_month': {
      const start = new Date(Date.UTC(currentYear, currentMonth, 1, 0, 0, 0))
      const end = new Date(Date.UTC(currentYear, currentMonth + 1, 1, 0, 0, 0))
      const label = start.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
      return { start, end, label }
    }

    case 'last_month': {
      const lastMonth = currentMonth === 0 ? 11 : currentMonth - 1
      const year = currentMonth === 0 ? currentYear - 1 : currentYear
      const start = new Date(Date.UTC(year, lastMonth, 1, 0, 0, 0))
      const end = new Date(Date.UTC(year, lastMonth + 1, 1, 0, 0, 0))
      const label = start.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
      return { start, end, label }
    }

    case 'current_quarter': {
      const quarterStartMonth = Math.floor(currentMonth / 3) * 3
      const start = new Date(Date.UTC(currentYear, quarterStartMonth, 1, 0, 0, 0))
      const end = new Date(Date.UTC(currentYear, quarterStartMonth + 3, 1, 0, 0, 0))
      const quarter = Math.floor(quarterStartMonth / 3) + 1
      const label = `Q${quarter} ${currentYear}`
      return { start, end, label }
    }

    case 'last_year': {
      const lastYear = currentYear - 1
      const start = new Date(Date.UTC(lastYear, 0, 1, 0, 0, 0))
      const end = new Date(Date.UTC(lastYear + 1, 0, 1, 0, 0, 0))
      const label = `${lastYear}`
      return { start, end, label }
    }

    default:
      return null
  }
}

/**
 * Validate period parameter
 */
export function isValidPeriod(period: string): period is PeriodType {
  return ['current_month', 'last_month', 'current_quarter', 'last_year'].includes(period)
}
