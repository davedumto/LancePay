import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import {
  requireWalletActor,
  requireWalletSigner,
} from '@/app/api/_lib/collective-wallet-auth'

type RouteContext = { params: Promise<{ id: string }> }

/**
 * POST /api/collective-wallets/[id]/proposals/expire-sweep
 *
 * Maintenance endpoint that transitions past-due pending proposals to expired.
 * Only proposals with status 'pending' and expiresAt <= now are updated.
 * Leave executing, executed, and other non-pending proposals untouched.
 * Idempotent: repeated runs produce no duplicate side effects.
 * Returns the count of proposals transitioned.
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const auth = await requireWalletActor(request)
    if ('response' in auth) return auth.response

    const { id } = await params
    if (!id || id.trim() === '') {
      return NextResponse.json({ error: 'Wallet ID is required' }, { status: 400 })
    }

    const access = await requireWalletSigner(id, auth.actor.id)
    if ('response' in access) return access.response

    const now = new Date()

    const result = await prisma.multisigProposal.updateMany({
      where: {
        walletId: id,
        status: 'pending',
        expiresAt: { lte: now },
      },
      data: {
        status: 'expired',
      },
    })

    logger.info(
      { walletId: id, actorId: auth.actor.id, count: result.count },
      'Expired stale proposals sweep executed'
    )

    return NextResponse.json({
      count: result.count,
      expiredCount: result.count,
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/collective-wallets/[id]/proposals/expire-sweep error')
    return NextResponse.json({ error: 'Failed to expire stale proposals' }, { status: 500 })
  }
}
