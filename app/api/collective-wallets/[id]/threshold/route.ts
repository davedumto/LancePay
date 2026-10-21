import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { requireWalletActor, requireWalletSigner } from '@/app/api/_lib/collective-wallet-auth'

type RouteContext = { params: Promise<{ id: string }> }

/**
 * PATCH /api/collective-wallets/[id]/threshold
 * Update the signing threshold of the collective wallet.
 *
 * Rules:
 * - Reject a new threshold greater than the sum of current signer weights.
 * - Require sign-off from a majority of existing signers (not just the requester).
 * - Leave in-flight pending proposals unaffected for future proposals.
 */
export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const auth = await requireWalletActor(request)
    if ('response' in auth) return auth.response

    const { id } = await params
    const access = await requireWalletSigner(id, auth.actor.id)
    if ('response' in access) return access.response
    const { wallet } = access

    let body: Record<string, unknown> | null = null
    try {
      body = (await request.json()) as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const rawThreshold = body?.threshold ?? body?.newThreshold
    const threshold = Number(rawThreshold)

    if (!Number.isInteger(threshold) || threshold < 1) {
      return NextResponse.json(
        { error: 'threshold must be an integer greater than or equal to 1' },
        { status: 400 }
      )
    }

    const signers = await prisma.walletSigner.findMany({
      where: { walletId: id },
      select: { id: true, userId: true, weight: true },
    })

    const totalWeight = signers.reduce((sum, s) => sum + s.weight, 0)
    if (threshold > totalWeight) {
      return NextResponse.json(
        {
          error: `threshold cannot exceed the sum of current signer weights (${totalWeight})`,
          code: 'THRESHOLD_EXCEEDS_SIGNER_WEIGHTS',
          details: { threshold, totalWeight },
        },
        { status: 400 }
      )
    }

    const rawApprovals = [
      ...(Array.isArray(body?.approvals) ? body.approvals : []),
      ...(Array.isArray(body?.signOffs) ? body.signOffs : []),
      ...(Array.isArray(body?.signerIds) ? body.signerIds : []),
    ]

    const approverSet = new Set<string>([auth.actor.id, ...rawApprovals])
    const approvedSigners = signers.filter(
      (s) => approverSet.has(s.userId) || approverSet.has(s.id)
    )

    const requiredMajority = Math.floor(signers.length / 2) + 1
    if (approvedSigners.length < requiredMajority) {
      return NextResponse.json(
        {
          error: 'Threshold update requires sign-off from a majority of existing signers',
          code: 'MAJORITY_APPROVAL_REQUIRED',
          details: {
            approvedCount: approvedSigners.length,
            requiredMajority,
            totalSigners: signers.length,
          },
        },
        { status: 403 }
      )
    }

    const updatedWallet = await prisma.collectiveWallet.update({
      where: { id },
      data: { threshold },
      select: {
        id: true,
        name: true,
        stellarAddress: true,
        threshold: true,
        createdAt: true,
      },
    })

    logger.info(
      { walletId: id, requesterId: auth.actor.id, oldThreshold: wallet.threshold, newThreshold: threshold },
      'Collective wallet threshold updated'
    )

    return NextResponse.json({
      wallet: updatedWallet,
      threshold: updatedWallet.threshold,
      previousThreshold: wallet.threshold,
      message: 'Signing threshold updated successfully',
    })
  } catch (error) {
    logger.error({ err: error }, 'PATCH /api/collective-wallets/[id]/threshold error')
    return NextResponse.json({ error: 'Failed to update wallet threshold' }, { status: 500 })
  }
}
