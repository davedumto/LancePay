import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { getAuthContext } from '@/app/api/routes-d/disputes/_shared'
import { encrypt } from '@/lib/crypto'
import { isValidStellarAddress } from '@/lib/stellar'
import { Keypair } from '@stellar/stellar-sdk'
import { computeProposalProgress, expireProposalIfStale, progressSummary } from './_shared'
import { logger } from '@/lib/logger'

const CreateWalletSchema = z.object({
  name: z.string().min(1).max(100),
  threshold: z.number().int().positive().default(2),
  stellarAddress: z.string().length(56).optional(),
  stellarSecretKey: z.string().optional(),
  signers: z.array(z.object({
    userId: z.string().min(1),
    weight: z.number().int().positive().optional(),
  })).min(1),
})

function sumWeights(signers: Array<{ weight?: number }>) {
  return signers.reduce((sum, s) => sum + (s.weight ?? 1), 0)
}

function uniqueUserIds(signers: Array<{ userId: string }>) {
  return new Set(signers.map((s) => s.userId)).size === signers.length
}

export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthContext(request)
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: 401 })

    const proposalId = request.nextUrl.searchParams.get('proposalId')
    const walletId = request.nextUrl.searchParams.get('walletId')

    if (proposalId) {
      await expireProposalIfStale(proposalId)
      const proposal = await prisma.multisigProposal.findUnique({
        where: { id: proposalId },
        include: {
          wallet: true,
          proposer: { select: { id: true, email: true, name: true } },
        },
      })
      if (!proposal) return NextResponse.json({ error: 'Proposal not found' }, { status: 404 })

      const signer = await prisma.walletSigner.findUnique({
        where: { walletId_userId: { walletId: proposal.walletId, userId: auth.user.id } },
      })
      if (!signer) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

      const progress = await computeProposalProgress(proposal.id, proposal.walletId, proposal.wallet.threshold)

      return NextResponse.json({
        proposal: {
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
          createdAt: proposal.createdAt.toISOString(),
        },
        progress: {
          approvedWeight: progress.approvedWeight,
          threshold: progress.threshold,
          summary: progressSummary(progress),
        },
      })
    }

    if (walletId) {
      const signer = await prisma.walletSigner.findUnique({
        where: { walletId_userId: { walletId, userId: auth.user.id } },
      })
      if (!signer) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

      await prisma.multisigProposal.updateMany({
        where: {
          walletId,
          status: 'pending',
          executedAt: null,
          executionStartedAt: null,
          expiresAt: { lte: new Date() },
        },
        data: { status: 'expired' },
      })

      const wallet = await prisma.collectiveWallet.findUnique({
        where: { id: walletId },
        include: {
          signers: {
            include: {
              user: { select: { id: true, email: true, name: true } },
            },
            orderBy: { createdAt: 'asc' },
          },
          proposals: {
            orderBy: { createdAt: 'desc' },
            take: 50,
          },
        },
      })
      if (!wallet) return NextResponse.json({ error: 'Wallet not found' }, { status: 404 })

      const proposalsWithProgress = await Promise.all(wallet.proposals.map(async (p) => {
        const progress = await computeProposalProgress(p.id, p.walletId, wallet.threshold)
        return {
          id: p.id,
          proposerId: p.proposerId,
          destination: p.destinationAddress,
          amount: Number(p.amountUsdc),
          memo: p.memo,
          status: p.status,
          expiresAt: p.expiresAt.toISOString(),
          executedAt: p.executedAt?.toISOString() || null,
          stellarTxHash: p.stellarTxHash || null,
          createdAt: p.createdAt.toISOString(),
          progress: {
            approvedWeight: progress.approvedWeight,
            threshold: progress.threshold,
            summary: progressSummary(progress),
          },
        }
      }))

      return NextResponse.json({
        wallet: {
          id: wallet.id,
          name: wallet.name,
          threshold: wallet.threshold,
          stellarAddress: wallet.stellarAddress,
          hasSecretKey: Boolean(wallet.encryptedSecretKey),
          createdAt: wallet.createdAt.toISOString(),
        },
        signers: wallet.signers.map((s) => ({
          id: s.id,
          userId: s.userId,
          weight: s.weight,
          createdAt: s.createdAt.toISOString(),
          user: s.user,
        })),
        proposals: proposalsWithProgress,
      })
    }

    const wallets = await prisma.collectiveWallet.findMany({
      where: {
        signers: {
          some: { userId: auth.user.id },
        },
      },
      include: {
        signers: {
          select: { userId: true, weight: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({
      wallets: wallets.map((w) => ({
        id: w.id,
        name: w.name,
        threshold: w.threshold,
        stellarAddress: w.stellarAddress,
        createdAt: w.createdAt.toISOString(),
        signerCount: w.signers.length,
        totalWeight: w.signers.reduce((sum, s) => sum + s.weight, 0),
        hasSecretKey: Boolean(w.encryptedSecretKey),
      })),
    })
  } catch (error) {
    logger.error({ err: error }, 'Teams multisig GET error:')
    return NextResponse.json({ error: 'Failed to fetch multi-sig data' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthContext(request)
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: 401 })

    const body = await request.json()
    const parsed = CreateWalletSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid request' }, { status: 400 })
    }

    const { name, threshold, stellarAddress, stellarSecretKey, signers } = parsed.data

    if (!uniqueUserIds(signers)) {
      return NextResponse.json({ error: 'Duplicate signers are not allowed' }, { status: 400 })
    }

    const totalWeight = sumWeights(signers)
    if (threshold > totalWeight) {
      return NextResponse.json(
        { error: `threshold (${threshold}) exceeds total signer weight (${totalWeight})` },
        { status: 400 }
      )
    }

    const requesterIncluded = signers.some((s) => s.userId === auth.user.id)
    if (!requesterIncluded) {
      return NextResponse.json({ error: 'You must be included as a signer to create a collective wallet' }, { status: 403 })
    }

    let finalStellarAddress = stellarAddress
    let encryptedSecretKey: string | null = null

    if (stellarSecretKey) {
      try {
        const normalized = stellarSecretKey.trim()
        const kp = Keypair.fromSecret(normalized)
        finalStellarAddress = kp.publicKey()
        encryptedSecretKey = encrypt(normalized)
      } catch {
        return NextResponse.json({ error: 'Invalid stellarSecretKey' }, { status: 400 })
      }
    }

    if (!finalStellarAddress) {
      return NextResponse.json({ error: 'stellarAddress or stellarSecretKey is required' }, { status: 400 })
    }

    if (!isValidStellarAddress(finalStellarAddress)) {
      return NextResponse.json({ error: 'Invalid stellarAddress' }, { status: 400 })
    }

    // Ensure all users exist
    const userIds = signers.map((s) => s.userId)
    const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true } })
    if (users.length !== userIds.length) {
      return NextResponse.json({ error: 'One or more signer users were not found' }, { status: 404 })
    }

    const created = await prisma.$transaction(async (tx: any) => {
      const wallet = await tx.collectiveWallet.create({
        data: {
          name,
          threshold,
          stellarAddress: finalStellarAddress!,
          encryptedSecretKey,
        },
      })

      await tx.walletSigner.createMany({
        data: signers.map((s) => ({
          walletId: wallet.id,
          userId: s.userId,
          weight: s.weight ?? 1,
        })),
      })

      return wallet
    })

    return NextResponse.json(
      {
        wallet: {
          id: created.id,
          name: created.name,
          threshold: created.threshold,
          stellarAddress: created.stellarAddress,
          createdAt: created.createdAt.toISOString(),
          signerCount: signers.length,
          totalWeight,
          hasSecretKey: Boolean(encryptedSecretKey),
        },
      },
      { status: 201 }
    )
  } catch (error) {
    logger.error({ err: error }, 'Teams multisig POST error:')
    return NextResponse.json({ error: 'Failed to create collective wallet' }, { status: 500 })
  }
}
