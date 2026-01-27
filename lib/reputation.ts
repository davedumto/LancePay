import { prisma } from './db'
import { Decimal } from '@prisma/client/runtime/library'
import type { UserTrustScore } from '@prisma/client'

export interface LanceScoreBreakdown {
  baseScore: number
  volumeBonus: number
  historyBonus: number
  disputePenalty: number
  verificationBonus: number
  totalVolumeUsdc: number
  successfulInvoices: number
  lostDisputes: number
  isVerified: boolean
}

export interface LanceScoreData {
  score: number
  tier: string
  breakdown: LanceScoreBreakdown
  lastUpdatedAt: Date
}

/**
 * Calculate LanceScore based on performance metrics
 * Formula:
 * - Base: 50 points
 * - Volume bonus: +1 per $1,000 (capped at +20)
 * - History bonus: +1 per 5 successful invoices (capped at +15)
 * - Dispute penalty: -10 per lost dispute
 * - Verification bonus: +15 points for completing KYC/KYB
 * - Final score clamped to 0-100
 */
export function calculateLanceScore(params: {
  totalVolumeUsdc: number
  successfulInvoices: number
  lostDisputes: number
  isVerified: boolean
}): { score: number; breakdown: LanceScoreBreakdown } {
  const baseScore = 50

  // Volume bonus: +1 point per $1,000, capped at +20
  const volumeBonus = Math.min(20, Math.floor(params.totalVolumeUsdc / 1000))

  // History bonus: +1 point per 5 invoices, capped at +15
  const historyBonus = Math.min(15, Math.floor(params.successfulInvoices / 5))

  // Dispute penalty: -10 points per lost dispute
  const disputePenalty = -10 * params.lostDisputes

  // Verification bonus: +15 points for completing KYC/KYB
  const verificationBonus = params.isVerified ? 15 : 0

  // Calculate final score
  const rawScore = baseScore + volumeBonus + historyBonus + disputePenalty + verificationBonus
  const score = Math.max(0, Math.min(100, rawScore)) // Clamp to 0-100

  return {
    score,
    breakdown: {
      baseScore,
      volumeBonus,
      historyBonus,
      disputePenalty,
      verificationBonus,
      totalVolumeUsdc: params.totalVolumeUsdc,
      successfulInvoices: params.successfulInvoices,
      lostDisputes: params.lostDisputes,
      isVerified: params.isVerified,
    },
  }
}

/**
 * Get trust score tier based on score
 */
export function getTrustScoreTier(score: number): string {
  if (score >= 85) return 'Elite Freelancer'
  if (score >= 70) return 'Trusted Freelancer'
  if (score >= 50) return 'Standard Freelancer'
  return 'New Freelancer'
}

/**
 * Aggregate user performance metrics from database
 */
async function aggregateUserMetrics(userId: string): Promise<{
  totalVolumeUsdc: number
  successfulInvoices: number
  lostDisputes: number
  isVerified: boolean
}> {
  // Calculate total volume from completed payment transactions
  const volumeResult = await prisma.transaction.aggregate({
    where: {
      userId,
      status: 'completed',
      type: { in: ['incoming', 'payment'] },
    },
    _sum: {
      amount: true,
    },
  })

  const totalVolumeUsdc = Number(volumeResult._sum.amount || 0)

  // Count successful invoices (status = 'paid')
  const successfulInvoices = await prisma.invoice.count({
    where: {
      userId,
      status: 'paid',
    },
  })

  // Count lost disputes
  // A dispute is "lost" if it was resolved with a refund (refund_full or refund_partial)
  // We check disputes where the invoice status is 'refunded' or 'partially_refunded'
  // and the dispute status is 'resolved'
  const lostDisputes = await prisma.dispute.count({
    where: {
      invoice: {
        userId,
        status: { in: ['refunded', 'partially_refunded'] },
      },
      status: 'resolved',
    },
  })

  // Check if user has verified bank account (KYC/KYB verification)
  const hasVerifiedBank = await prisma.bankAccount.findFirst({
    where: {
      userId,
      isVerified: true,
    },
  })

  return {
    totalVolumeUsdc,
    successfulInvoices,
    lostDisputes,
    isVerified: !!hasVerifiedBank,
  }
}

/**
 * Recalculate and update user trust score
 * This function aggregates data and updates the UserTrustScore record
 * 
 * Edge cases handled:
 * - Zero transactions: Returns base score of 50
 * - Missing record: Creates on first calculation via upsert
 * - Concurrent updates: Prisma upsert is atomic and handles race conditions
 * - Score bounds: Clamped to 0-100 in calculateLanceScore
 */
export async function updateUserTrustScore(
  userId: string
): Promise<UserTrustScore | null> {
  try {
    // Aggregate metrics
    const metrics = await aggregateUserMetrics(userId)

    // Calculate score
    const { score, breakdown } = calculateLanceScore(metrics)

    // Upsert trust score record (atomic operation handles concurrent updates)
    const trustScore = await prisma.userTrustScore.upsert({
      where: { userId },
      create: {
        userId,
        score,
        totalVolumeUsdc: new Decimal(metrics.totalVolumeUsdc),
        disputeCount: metrics.lostDisputes,
        successfulInvoices: metrics.successfulInvoices,
        lastUpdatedAt: new Date(),
      },
      update: {
        score,
        totalVolumeUsdc: new Decimal(metrics.totalVolumeUsdc),
        disputeCount: metrics.lostDisputes,
        successfulInvoices: metrics.successfulInvoices,
        lastUpdatedAt: new Date(),
      },
    })

    return trustScore
  } catch (error) {
    console.error(`Failed to update trust score for user ${userId}:`, error)
    if (error instanceof Error) {
      console.error('Error details:', error.message, error.stack)
      // Check if it's a table not found error
      if (error.message.includes('does not exist') || error.message.includes('Unknown table')) {
        console.error('⚠️  ERROR: La tabla UserTrustScore no existe. Ejecuta: npx prisma migrate dev')
      }
    }
    // Don't throw - graceful degradation
    return null
  }
}

/**
 * Get user trust score data with breakdown
 * If no score exists, calculates it on the fly
 */
export async function getUserTrustScoreData(
  userId: string
): Promise<LanceScoreData | null> {
  try {
    // Try to get existing score
    let trustScore = await prisma.userTrustScore.findUnique({
      where: { userId },
    })

    // If no score exists, calculate it
    if (!trustScore) {
      const updated = await updateUserTrustScore(userId)
      if (!updated) {
        console.error(`Failed to create trust score for user ${userId}`)
        return null
      }
      trustScore = updated
    }

    // Get breakdown by recalculating (to ensure consistency)
    const metrics = await aggregateUserMetrics(userId)
    const { score, breakdown } = calculateLanceScore(metrics)

    return {
      score,
      tier: getTrustScoreTier(score),
      breakdown,
      lastUpdatedAt: trustScore.lastUpdatedAt,
    }
  } catch (error) {
    console.error(`Failed to get trust score data for user ${userId}:`, error)
    if (error instanceof Error) {
      console.error('Error details:', error.message, error.stack)
    }
    return null
  }
}

/**
 * Get public trust score data (limited information)
 */
export async function getPublicTrustScoreData(
  userId: string
): Promise<{
  score: number
  tier: string
  totalPaidInvoices: number
  isVerified: boolean
} | null> {
  try {
    const data = await getUserTrustScoreData(userId)
    if (!data) return null

    // Count total paid invoices for public display
    const totalPaidInvoices = await prisma.invoice.count({
      where: {
        userId,
        status: 'paid',
      },
    })

    // Check if user has verified bank account (placeholder for future KYC)
    const hasVerifiedBank = await prisma.bankAccount.findFirst({
      where: {
        userId,
        isVerified: true,
      },
    })

    return {
      score: data.score,
      tier: data.tier,
      totalPaidInvoices,
      isVerified: !!hasVerifiedBank,
    }
  } catch (error) {
    console.error(`Failed to get public trust score for user ${userId}:`, error)
    return null
  }
}
