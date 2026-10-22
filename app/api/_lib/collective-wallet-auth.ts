import { NextRequest, NextResponse } from 'next/server'
import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'

export interface WalletActor {
  id: string
  email: string
}

export interface SignerWallet {
  id: string
  stellarAddress: string
  threshold: number
}

/** Stellar caps signer weights at 255 and an account at 20 signers. */
export const MAX_SIGNER_WEIGHT = 255
export const MAX_SIGNERS = 20

/** Fields of a signer's user that are safe to expose to co-signers. */
export const SIGNER_USER_SELECT = { id: true, name: true, email: true } as const

export function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

export async function requireWalletActor(
  request: NextRequest
): Promise<{ actor: WalletActor } | { response: NextResponse }> {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const claims = await verifyAuthToken(authToken)
  if (!claims) return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const actor = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true, email: true },
  })
  if (!actor) return { response: NextResponse.json({ error: 'User not found' }, { status: 404 }) }

  return { actor }
}

/**
 * Loads a wallet and confirms the actor is one of its signers.
 *
 * CollectiveWallet has no creator column: the creator is enrolled as a signer
 * when the wallet is created, so "signer" is the single membership check.
 */
export async function requireWalletSigner(
  walletId: string,
  actorId: string
): Promise<{ wallet: SignerWallet } | { response: NextResponse }> {
  const wallet = await prisma.collectiveWallet.findUnique({
    where: { id: walletId },
    select: {
      id: true,
      stellarAddress: true,
      threshold: true,
      signers: { where: { userId: actorId }, select: { id: true } },
    },
  })

  if (!wallet) {
    return {
      response: NextResponse.json(
        { error: 'Wallet not found', code: 'WALLET_NOT_FOUND' },
        { status: 404 }
      ),
    }
  }
  if (wallet.signers.length === 0) {
    return {
      response: NextResponse.json(
        { error: 'Forbidden: only wallet signers can perform this action', code: 'NOT_A_SIGNER' },
        { status: 403 }
      ),
    }
  }

  return { wallet: { id: wallet.id, stellarAddress: wallet.stellarAddress, threshold: wallet.threshold } }
}
