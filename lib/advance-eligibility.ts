import { prisma } from './db'

export interface EligibilityResult {
  eligible: boolean
  reason?: string
  trustScore?: number
  maxAdvanceAmount?: number
}

export const ELIGIBILITY_CRITERIA = {
  MIN_COMPLETED_INVOICES: 3,
  MIN_TOTAL_EARNED: 100, // USD
  MAX_OUTSTANDING_ADVANCES: 5000, // USD
  MIN_ACCOUNT_AGE_DAYS: 7,
  MAX_ADVANCE_PERCENTAGE: 0.50, // 50% of invoice
  ADVANCE_FEE_PERCENTAGE: 0.02, // 2% fee
}

/**
 * Calculate a basic trust score based on user history
 * Score ranges from 0-100
 */
export async function calculateTrustScore(userId: string): Promise<number> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      invoices: {
        where: { status: 'paid' },
      },
      transactions: {
        where: {
          type: 'incoming',
          status: 'completed',
        },
      },
      paymentAdvances: {
        where: { status: 'repaid' },
      },
    },
  })

  if (!user) return 0

  let score = 0

  // Account age (max 20 points)
  const accountAgeDays = Math.floor(
    (Date.now() - user.createdAt.getTime()) / (1000 * 60 * 60 * 24)
  )
  score += Math.min(20, accountAgeDays)

  // Completed invoices (max 30 points)
  const completedInvoices = user.invoices.length
  score += Math.min(30, completedInvoices * 3)

  // Total earned (max 25 points)
  const totalEarned = user.transactions.reduce(
    (sum, tx) => sum + Number(tx.amount),
    0
  )
  score += Math.min(25, Math.floor(totalEarned / 100))

  // Advance repayment history (max 25 points)
  const repaidAdvances = user.paymentAdvances?.length || 0
  score += Math.min(25, repaidAdvances * 5)

  return Math.min(100, score)
}

/**
 * Check if user is eligible for a payment advance
 */
export async function checkAdvanceEligibility(
  userId: string,
  invoiceId: string,
  requestedAmount: number
): Promise<EligibilityResult> {
  // Get user with invoice and advance history
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      invoices: {
        where: { id: invoiceId },
      },
      paymentAdvances: {
        where: {
          status: { in: ['pending', 'disbursed'] },
        },
      },
      bankAccounts: {
        where: { isVerified: true },
      },
    },
  })

  if (!user) {
    return { eligible: false, reason: 'User not found' }
  }

  // Check if invoice exists and belongs to user
  const invoice = user.invoices[0]
  if (!invoice) {
    return {
      eligible: false,
      reason: 'Invoice not found or does not belong to you',
    }
  }

  // Check invoice status
  if (invoice.status !== 'pending') {
    return { eligible: false, reason: 'Invoice must be in pending status' }
  }

  // Check if invoice already has an active lien
  if (invoice.lienActive) {
    return {
      eligible: false,
      reason: 'Invoice already has an active advance',
    }
  }

  // Check verified bank account
  if (user.bankAccounts.length === 0) {
    return {
      eligible: false,
      reason:
        'No verified bank account found. Please add and verify a bank account first.',
    }
  }

  // Check account age
  const accountAgeDays = Math.floor(
    (Date.now() - user.createdAt.getTime()) / (1000 * 60 * 60 * 24)
  )
  if (accountAgeDays < ELIGIBILITY_CRITERIA.MIN_ACCOUNT_AGE_DAYS) {
    return {
      eligible: false,
      reason: `Account must be at least ${ELIGIBILITY_CRITERIA.MIN_ACCOUNT_AGE_DAYS} days old`,
    }
  }

  // Check completed invoices
  const completedInvoices = await prisma.invoice.count({
    where: {
      userId,
      status: 'paid',
    },
  })

  if (completedInvoices < ELIGIBILITY_CRITERIA.MIN_COMPLETED_INVOICES) {
    return {
      eligible: false,
      reason: `You need at least ${ELIGIBILITY_CRITERIA.MIN_COMPLETED_INVOICES} completed invoices. Current: ${completedInvoices}`,
    }
  }

  // Check total earnings
  const totalEarned = await prisma.transaction.aggregate({
    where: {
      userId,
      type: 'incoming',
      status: 'completed',
    },
    _sum: { amount: true },
  })

  const earnings = Number(totalEarned._sum.amount || 0)
  if (earnings < ELIGIBILITY_CRITERIA.MIN_TOTAL_EARNED) {
    return {
      eligible: false,
      reason: `Minimum earnings requirement not met. Need $${ELIGIBILITY_CRITERIA.MIN_TOTAL_EARNED}, current: $${earnings.toFixed(2)}`,
    }
  }

  // Check outstanding advances
  const outstandingAdvances = user.paymentAdvances.reduce(
    (sum, adv) => sum + Number(adv.totalRepaymentUSDC),
    0
  )

  if (outstandingAdvances >= ELIGIBILITY_CRITERIA.MAX_OUTSTANDING_ADVANCES) {
    return {
      eligible: false,
      reason: `Maximum outstanding advances limit reached ($${ELIGIBILITY_CRITERIA.MAX_OUTSTANDING_ADVANCES})`,
    }
  }

  // Check advance amount vs invoice amount
  const invoiceAmount = Number(invoice.amount)
  const maxAdvance =
    invoiceAmount * ELIGIBILITY_CRITERIA.MAX_ADVANCE_PERCENTAGE

  if (requestedAmount > maxAdvance) {
    return {
      eligible: false,
      reason: `Requested amount ($${requestedAmount}) exceeds maximum allowed (50% of invoice: $${maxAdvance.toFixed(2)})`,
      maxAdvanceAmount: maxAdvance,
    }
  }

  // Calculate trust score
  const trustScore = await calculateTrustScore(userId)

  return {
    eligible: true,
    trustScore,
    maxAdvanceAmount: maxAdvance,
  }
}

/**
 * Check if user has any outstanding advances
 */
export async function hasOutstandingAdvances(
  userId: string
): Promise<boolean> {
  const count = await prisma.paymentAdvance.count({
    where: {
      userId,
      status: { in: ['pending', 'disbursed'] },
    },
  })

  return count > 0
}

/**
 * Get total outstanding advance amount for user
 */
export async function getTotalOutstandingAdvances(
  userId: string
): Promise<number> {
  const result = await prisma.paymentAdvance.aggregate({
    where: {
      userId,
      status: { in: ['pending', 'disbursed'] },
    },
    _sum: { totalRepaymentUSDC: true },
  })

  return Number(result._sum.totalRepaymentUSDC || 0)
}
