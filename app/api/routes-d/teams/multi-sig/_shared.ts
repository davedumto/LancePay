import { prisma } from '@/lib/db'

export const MULTISIG_PROPOSAL_TTL_MS = 48 * 60 * 60 * 1000

export function proposalExpiresAt(now: Date = new Date()) {
  return new Date(now.getTime() + MULTISIG_PROPOSAL_TTL_MS)
}

export function progressSummary(params: { approvedWeight: number; threshold: number }) {
  const approved = Math.min(params.approvedWeight, params.threshold)
  return `${approved} of ${params.threshold} approved`
}

export async function computeProposalProgress(proposalId: string, walletId: string, threshold: number) {
  const signatures = await prisma.proposalSignature.findMany({
    where: { proposalId },
    select: { signerId: true },
  })

  const signerIds = signatures.map((s) => s.signerId)
  const signerWeights = signerIds.length === 0 ? [] : await prisma.walletSigner.findMany({
    where: { walletId, userId: { in: signerIds } },
    select: { userId: true, weight: true },
  })

  const approvedWeight = signerWeights.reduce((sum, s) => sum + s.weight, 0)
  const uniqueApprovers = new Set(signerIds).size

  return {
    threshold,
    approvedWeight,
    uniqueApprovers,
    isApproved: approvedWeight >= threshold,
  }
}

export async function expireProposalIfStale(proposalId: string, now: Date = new Date()) {
  await prisma.multisigProposal.updateMany({
    where: {
      id: proposalId,
      status: 'pending',
      executedAt: null,
      executionStartedAt: null,
      expiresAt: { lte: now },
    },
    data: { status: 'expired' },
  })
}

