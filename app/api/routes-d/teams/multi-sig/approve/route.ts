import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { getAuthContext } from '@/app/api/routes-d/disputes/_shared'
import { decrypt } from '@/lib/crypto'
import { isValidStellarAddress, sendUSDCPayment } from '@/lib/stellar'
import { Keypair } from '@stellar/stellar-sdk'
import { computeProposalProgress, expireProposalIfStale, progressSummary } from '../_shared'
import { logger } from '@/lib/logger'

const ApproveSchema = z.object({
  proposalId: z.string().min(1),
})

function serializeProposal(proposal: {
  id: string
  walletId: string
  proposerId: string
  destinationAddress: string
  amountUsdc: any
  memo: string | null
  status: string
  expiresAt: Date
  executedAt: Date | null
  stellarTxHash: string | null
  createdAt: Date
  executionStartedAt: Date | null
  lastError: string | null
}) {
  return {
    id: proposal.id,
    walletId: proposal.walletId,
    proposerId: proposal.proposerId,
    destination: proposal.destinationAddress,
    amount: Number(proposal.amountUsdc),
    memo: proposal.memo,
    status: proposal.status,
    expiresAt: proposal.expiresAt.toISOString(),
    executedAt: proposal.executedAt?.toISOString() || null,
    stellarTxHash: proposal.stellarTxHash || null,
    executionStartedAt: proposal.executionStartedAt?.toISOString() || null,
    lastError: proposal.lastError || null,
    createdAt: proposal.createdAt.toISOString(),
  }
}

function safeErrorMessage(error: unknown) {
  if (!error) return 'Unknown error'
  if (typeof error === 'string') return error
  if (typeof error === 'object' && 'message' in error && typeof (error as any).message === 'string') {
    return (error as any).message
  }
  return 'Unknown error'
}

function resolveWalletSecretKey(params: {
  stellarAddress: string
  encryptedSecretKey: string | null
}) {
  if (params.encryptedSecretKey) {
    const decrypted = decrypt(params.encryptedSecretKey)
    const kp = Keypair.fromSecret(decrypted)
    if (kp.publicKey() !== params.stellarAddress) {
      throw new Error('Stored secret key does not match wallet stellarAddress')
    }
    return decrypted
  }

  const envSecret = process.env.STELLAR_SECRET_KEY
  if (!envSecret) return null
  const kp = Keypair.fromSecret(envSecret)
  if (kp.publicKey() !== params.stellarAddress) return null
  return envSecret
}

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthContext(request)
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: 401 })

    const body = await request.json()
    const parsed = ApproveSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid request' }, { status: 400 })
    }

    const now = new Date()
    await expireProposalIfStale(parsed.data.proposalId, now)

    const proposal = await prisma.multisigProposal.findUnique({
      where: { id: parsed.data.proposalId },
      include: { wallet: true },
    })
    if (!proposal) return NextResponse.json({ error: 'Proposal not found' }, { status: 404 })

    const signer = await prisma.walletSigner.findUnique({
      where: { walletId_userId: { walletId: proposal.walletId, userId: auth.user.id } },
      select: { id: true },
    })
    if (!signer) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    if (proposal.status === 'executed' || proposal.executedAt) {
      const progress = await computeProposalProgress(proposal.id, proposal.walletId, proposal.wallet.threshold)
      return NextResponse.json({
        proposal: serializeProposal(proposal),
        progress: { ...progress, summary: progressSummary(progress) },
      })
    }

    if (proposal.status === 'expired' || (proposal.expiresAt <= now && !proposal.executionStartedAt)) {
      return NextResponse.json({ error: 'Proposal expired' }, { status: 409 })
    }

    try {
      await prisma.proposalSignature.create({
        data: { proposalId: proposal.id, signerId: auth.user.id },
      })
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as any).code === 'P2002'
      ) {
        // idempotent: signature already exists
      } else {
        throw error
      }
    }

    const progress = await computeProposalProgress(proposal.id, proposal.walletId, proposal.wallet.threshold)
    if (!progress.isApproved) {
      const refreshed = await prisma.multisigProposal.findUnique({ where: { id: proposal.id } })
      return NextResponse.json({
        proposal: serializeProposal(refreshed ?? proposal),
        progress: { ...progress, summary: progressSummary(progress) },
      })
    }

    const claimed = await prisma.multisigProposal.updateMany({
      where: {
        id: proposal.id,
        status: 'pending',
        executedAt: null,
        executionStartedAt: null,
        expiresAt: { gt: now },
      },
      data: { executionStartedAt: now },
    })

    if (claimed.count === 0) {
      const refreshed = await prisma.multisigProposal.findUnique({ where: { id: proposal.id } })
      return NextResponse.json({
        proposal: serializeProposal(refreshed ?? proposal),
        progress: { ...progress, summary: progressSummary(progress) },
      })
    }

    if (!isValidStellarAddress(proposal.destinationAddress)) {
      await prisma.multisigProposal.update({
        where: { id: proposal.id },
        data: {
          executionStartedAt: null,
          lastError: 'Invalid destination Stellar address',
        },
      })
      return NextResponse.json({ error: 'Invalid destination Stellar address' }, { status: 400 })
    }

    let txHash: string
    try {
      const secretKey = resolveWalletSecretKey({
        stellarAddress: proposal.wallet.stellarAddress,
        encryptedSecretKey: proposal.wallet.encryptedSecretKey,
      })
      if (!secretKey) {
        throw new Error('Wallet secret key not available for execution')
      }

      txHash = await sendUSDCPayment(
        proposal.wallet.stellarAddress,
        secretKey,
        proposal.destinationAddress,
        proposal.amountUsdc.toString(),
        proposal.memo ?? undefined,
      )
    } catch (error: unknown) {
      const message = safeErrorMessage(error)
      await prisma.multisigProposal.update({
        where: { id: proposal.id },
        data: {
          executionStartedAt: null,
          lastError: message,
        },
      })
      return NextResponse.json({ error: 'Failed to execute Stellar transaction', details: message }, { status: 502 })
    }

    const updated = await prisma.multisigProposal.update({
      where: { id: proposal.id },
      data: {
        status: 'executed',
        executedAt: new Date(),
        stellarTxHash: txHash,
        lastError: null,
      },
      include: { wallet: true },
    })

    const refreshedProgress = await computeProposalProgress(updated.id, updated.walletId, updated.wallet.threshold)
    return NextResponse.json({
      proposal: serializeProposal(updated),
      progress: { ...refreshedProgress, summary: progressSummary(refreshedProgress) },
    })
  } catch (error) {
    logger.error({ err: error }, 'Teams multisig approve error:')
    return NextResponse.json({ error: 'Failed to approve proposal' }, { status: 500 })
  }
}

