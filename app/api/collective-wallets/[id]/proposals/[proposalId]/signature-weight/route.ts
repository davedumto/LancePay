import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

type RouteContext = {
  params:
    | Promise<{ id: string; proposalId: string }>
    | { id: string; proposalId: string }
}

async function resolveRouteParams(context?: RouteContext) {
  if (!context?.params) return { walletId: '', proposalId: '' }
  const resolved = await Promise.resolve(context.params)
  return {
    walletId: (resolved?.id ?? '').trim(),
    proposalId: (resolved?.proposalId ?? '').trim(),
  }
}

async function resolveAuthenticatedUser(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: 'Unauthorized', status: 401 as const, actor: null }
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return { error: 'Unauthorized', status: 401 as const, actor: null }
  }

  const claims = await verifyAuthToken(token)
  if (!claims) {
    return { error: 'Unauthorized', status: 401 as const, actor: null }
  }

  const actor =
    (await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true, email: true },
    })) ??
    (await prisma.user.findUnique({
      where: { id: claims.userId },
      select: { id: true, email: true },
    }))

  if (!actor) {
    return { error: 'User not found', status: 404 as const, actor: null }
  }

  return { error: null, status: 200 as const, actor }
}

/**
 * GET /api/collective-wallets/[id]/proposals/[proposalId]/signature-weight
 * Computes the current signature weight accumulated on a multisig proposal vs. the wallet's threshold:
 * - Restricts visibility to wallet signers.
 * - Joins each `ProposalSignature` to the corresponding `WalletSigner` weight (never assuming equal weight).
 * - Returns current total weight, required threshold, and a boolean indicating whether the threshold is met.
 */
export async function GET(req: NextRequest, context: RouteContext) {
  try {
    const auth = await resolveAuthenticatedUser(req)
    if (auth.error || !auth.actor) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const { walletId, proposalId } = await resolveRouteParams(context)
    if (!walletId || !proposalId) {
      return NextResponse.json(
        { error: 'Wallet ID and proposal ID are required' },
        { status: 400 },
      )
    }

    const wallet = await prisma.collectiveWallet.findUnique({
      where: { id: walletId },
      include: {
        signers: true,
      },
    })

    if (!wallet) {
      return NextResponse.json(
        { error: 'Collective wallet not found', code: 'WALLET_NOT_FOUND' },
        { status: 404 },
      )
    }

    const signers = (wallet.signers ?? []) as Array<{
      id: string
      walletId: string
      userId: string
      weight: number
    }>

    const isCallerWalletSigner = signers.some(
      (s) => s.userId === auth.actor.id,
    )
    if (!isCallerWalletSigner) {
      return NextResponse.json(
        {
          error:
            'Forbidden: only wallet signers can view proposal signature weights',
          code: 'NOT_A_SIGNER',
        },
        { status: 403 },
      )
    }

    const proposal = await prisma.multisigProposal.findUnique({
      where: { id: proposalId },
      include: {
        signatures: {
          orderBy: { createdAt: 'asc' },
        },
      },
    })

    if (!proposal || proposal.walletId !== wallet.id) {
      return NextResponse.json(
        {
          error: 'Multisig proposal not found in this collective wallet',
          code: 'PROPOSAL_NOT_FOUND',
        },
        { status: 404 },
      )
    }

    const rawSignatures =
      proposal.signatures ??
      (typeof prisma.proposalSignature?.findMany === 'function'
        ? await prisma.proposalSignature.findMany({
            where: { proposalId: proposal.id },
            orderBy: { createdAt: 'asc' },
          })
        : [])

    // Build lookup map from signer userId (and WalletSigner.id fallback) to WalletSigner weight
    const weightByUserId = new Map<string, number>()
    const weightBySignerRowId = new Map<string, number>()
    for (const signer of signers) {
      const numericWeight = Number(signer.weight)
      const safeWeight =
        Number.isFinite(numericWeight) && numericWeight >= 0
          ? numericWeight
          : 0
      weightByUserId.set(signer.userId, safeWeight)
      if (signer.id) {
        weightBySignerRowId.set(signer.id, safeWeight)
      }
    }

    const seenSigners = new Set<string>()
    let totalWeight = 0

    const weightedSignatures = (rawSignatures as Array<Record<string, any>>).map(
      (sig) => {
        const signerKey = String(sig.signerId ?? '')
        const resolvedWeight =
          weightByUserId.get(signerKey) ??
          weightBySignerRowId.get(signerKey) ??
          0
        const isDuplicate = seenSigners.has(signerKey)
        if (!isDuplicate && signerKey) {
          seenSigners.add(signerKey)
          totalWeight += resolvedWeight
        }

        return {
          id: sig.id,
          proposalId: sig.proposalId ?? proposal.id,
          signerId: signerKey,
          weight: resolvedWeight,
          countedInTotal: !isDuplicate && resolvedWeight > 0,
          signedAt: sig.createdAt
            ? new Date(sig.createdAt).toISOString()
            : null,
        }
      },
    )

    const requiredThreshold = Number(wallet.threshold)
    const thresholdMet = totalWeight >= requiredThreshold
    const remainingWeight = Math.max(0, requiredThreshold - totalWeight)

    return NextResponse.json({
      walletId: wallet.id,
      proposalId: proposal.id,
      proposalStatus: proposal.status,
      totalWeight,
      currentWeight: totalWeight,
      threshold: requiredThreshold,
      requiredThreshold,
      thresholdMet,
      isThresholdMet: thresholdMet,
      remainingWeight,
      signatureCount: weightedSignatures.length,
      signatures: weightedSignatures,
    })
  } catch (err) {
    logger?.error?.(
      { err },
      'GET /api/collective-wallets/[id]/proposals/[proposalId]/signature-weight error',
    )
    return NextResponse.json(
      { error: 'Failed to compute proposal signature weight' },
      { status: 500 },
    )
  }
}
