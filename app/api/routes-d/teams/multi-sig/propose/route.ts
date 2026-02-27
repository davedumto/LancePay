import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { getAuthContext } from '@/app/api/routes-d/disputes/_shared'
import { isValidStellarAddress } from '@/lib/stellar'
import { Decimal } from '@prisma/client/runtime/library'
import { progressSummary, proposalExpiresAt } from '../_shared'
import { logger } from '@/lib/logger'

const ProposeSchema = z.object({
  walletId: z.string().min(1),
  destination: z.string().min(1).max(255),
  amount: z.number().positive().refine((v) => Number.isFinite(v), { message: 'amount must be a finite number' }),
  memo: z.string().max(1000).optional(),
})

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthContext(request)
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: 401 })

    const body = await request.json()
    const parsed = ProposeSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid request' }, { status: 400 })
    }

    const destination = parsed.data.destination.trim()
    if (!isValidStellarAddress(destination)) {
      return NextResponse.json({ error: 'Invalid destination Stellar address' }, { status: 400 })
    }

    const wallet = await prisma.collectiveWallet.findUnique({
      where: { id: parsed.data.walletId },
      select: { id: true, threshold: true },
    })
    if (!wallet) return NextResponse.json({ error: 'Wallet not found' }, { status: 404 })

    const signer = await prisma.walletSigner.findUnique({
      where: { walletId_userId: { walletId: wallet.id, userId: auth.user.id } },
      select: { id: true },
    })
    if (!signer) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const amountStr = parsed.data.amount.toFixed(6)

    const proposal = await prisma.multisigProposal.create({
      data: {
        walletId: wallet.id,
        proposerId: auth.user.id,
        destinationAddress: destination,
        amountUsdc: new Decimal(amountStr),
        memo: parsed.data.memo?.trim() || null,
        status: 'pending',
        expiresAt: proposalExpiresAt(),
      },
    })

    return NextResponse.json(
      {
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
          approvedWeight: 0,
          threshold: wallet.threshold,
          uniqueApprovers: 0,
          isApproved: false,
          summary: progressSummary({ approvedWeight: 0, threshold: wallet.threshold }),
        },
      },
      { status: 201 }
    )
  } catch (error) {
    logger.error({ err: error }, 'Teams multisig propose error:')
    return NextResponse.json({ error: 'Failed to create proposal' }, { status: 500 })
  }
}

