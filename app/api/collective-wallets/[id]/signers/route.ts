import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import {
  MAX_SIGNERS,
  MAX_SIGNER_WEIGHT,
  SIGNER_USER_SELECT,
  isUniqueConstraintError,
  requireWalletActor,
  requireWalletSigner,
} from '@/app/api/_lib/collective-wallet-auth'

type RouteContext = { params: Promise<{ id: string }> }

const addSignerSchema = z.object({
  userId: z.string().trim().min(1, 'userId is required'),
  weight: z
    .number()
    .int('weight must be a positive integer')
    .positive('weight must be a positive integer')
    .max(MAX_SIGNER_WEIGHT)
    .default(1),
})

const SIGNER_SELECT = {
  id: true,
  userId: true,
  weight: true,
  createdAt: true,
  user: { select: SIGNER_USER_SELECT },
} as const

/**
 * GET /api/collective-wallets/[id]/signers
 * List signers of a wallet. Only signers of the wallet may view them.
 */
export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const auth = await requireWalletActor(request)
    if ('response' in auth) return auth.response

    const { id } = await params
    const access = await requireWalletSigner(id, auth.actor.id)
    if ('response' in access) return access.response

    const signers = await prisma.walletSigner.findMany({
      where: { walletId: id },
      select: SIGNER_SELECT,
      orderBy: { createdAt: 'asc' },
    })
    const totalWeight = signers.reduce((sum, s) => sum + s.weight, 0)

    return NextResponse.json({ signers, totalWeight, threshold: access.wallet.threshold })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/collective-wallets/[id]/signers error')
    return NextResponse.json({ error: 'Failed to fetch wallet signers' }, { status: 500 })
  }
}

/**
 * POST /api/collective-wallets/[id]/signers
 * Add a signer. Only existing signers (which includes the creator, who is
 * enrolled at wallet creation) may add new signers.
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const auth = await requireWalletActor(request)
    if ('response' in auth) return auth.response

    const { id } = await params
    const access = await requireWalletSigner(id, auth.actor.id)
    if ('response' in access) return access.response
    const { wallet } = access

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = addSignerSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      )
    }
    const { userId, weight } = parsed.data

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } })
    if (!user) {
      return NextResponse.json({ error: 'User not found', code: 'USER_NOT_FOUND' }, { status: 404 })
    }

    const existing = await prisma.walletSigner.findUnique({
      where: { walletId_userId: { walletId: wallet.id, userId } },
      select: { id: true },
    })
    if (existing) {
      return NextResponse.json(
        { error: 'User is already a signer on this wallet', code: 'DUPLICATE_SIGNER' },
        { status: 409 }
      )
    }

    const current = await prisma.walletSigner.aggregate({
      where: { walletId: wallet.id },
      _sum: { weight: true },
      _count: { _all: true },
    })
    if (current._count._all >= MAX_SIGNERS) {
      return NextResponse.json(
        { error: `A wallet can have at most ${MAX_SIGNERS} signers` },
        { status: 400 }
      )
    }

    const totalWeight = (current._sum.weight ?? 0) + weight
    if (totalWeight < wallet.threshold) {
      return NextResponse.json(
        {
          error: 'Total signer weight would not satisfy the wallet threshold',
          code: 'QUORUM_VIOLATION',
          details: { totalWeight, threshold: wallet.threshold },
        },
        { status: 422 }
      )
    }

    const signer = await prisma.walletSigner.create({
      data: { walletId: wallet.id, userId, weight },
      select: SIGNER_SELECT,
    })

    logger.info(
      { walletId: wallet.id, signerId: signer.id, addedBy: auth.actor.id, weight },
      'Collective wallet signer added'
    )

    return NextResponse.json({ signer, totalWeight, threshold: wallet.threshold }, { status: 201 })
  } catch (error) {
    // Lost a race with a concurrent add of the same user (@@unique([walletId, userId])).
    if (isUniqueConstraintError(error)) {
      return NextResponse.json(
        { error: 'User is already a signer on this wallet', code: 'DUPLICATE_SIGNER' },
        { status: 409 }
      )
    }
    logger.error({ err: error }, 'POST /api/collective-wallets/[id]/signers error')
    return NextResponse.json({ error: 'Failed to add wallet signer' }, { status: 500 })
  }
}
