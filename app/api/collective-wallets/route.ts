import { NextRequest, NextResponse } from 'next/server'
import { Keypair } from '@stellar/stellar-sdk'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { encrypt } from '@/lib/crypto'
import { isValidStellarAddress } from '@/lib/stellar'
import { logger } from '@/lib/logger'
import {
  MAX_SIGNERS,
  MAX_SIGNER_WEIGHT,
  SIGNER_USER_SELECT,
  isUniqueConstraintError,
  requireWalletActor,
} from '@/app/api/_lib/collective-wallet-auth'

const createCollectiveWalletSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(100),
  threshold: z.number().int('threshold must be an integer'),
  stellarAddress: z.string().trim().optional(),
  secretKey: z.string().trim().optional(),
  signers: z
    .array(
      z.object({
        userId: z.string().trim().min(1, 'userId is required'),
        weight: z.number().int().min(1).max(MAX_SIGNER_WEIGHT).default(1),
      })
    )
    .max(MAX_SIGNERS)
    .default([]),
})

const WALLET_RESPONSE_SELECT = {
  id: true,
  name: true,
  stellarAddress: true,
  threshold: true,
  createdAt: true,
  signers: {
    select: { id: true, userId: true, weight: true, createdAt: true, user: { select: SIGNER_USER_SELECT } },
    orderBy: { createdAt: 'asc' },
  },
} as const

/**
 * Resolves the wallet's Stellar keypair:
 * - neither supplied → generate a fresh keypair
 * - secretKey supplied → derive the address (and require it to match any supplied address)
 * - address only → externally-held key; nothing is stored
 */
function resolveStellarKeys(
  stellarAddress: string | undefined,
  secretKey: string | undefined
): { stellarAddress: string; secretKey: string | null } | { error: string } {
  if (secretKey) {
    let keypair: Keypair
    try {
      keypair = Keypair.fromSecret(secretKey)
    } catch {
      return { error: 'Invalid Stellar secret key' }
    }
    if (stellarAddress && keypair.publicKey() !== stellarAddress) {
      return { error: 'secretKey does not match stellarAddress' }
    }
    return { stellarAddress: keypair.publicKey(), secretKey }
  }

  if (stellarAddress) {
    if (!isValidStellarAddress(stellarAddress)) {
      return { error: 'Invalid Stellar address. Must be a 56-character address starting with "G".' }
    }
    return { stellarAddress, secretKey: null }
  }

  const keypair = Keypair.random()
  return { stellarAddress: keypair.publicKey(), secretKey: keypair.secret() }
}

/**
 * POST /api/collective-wallets
 * Create a multisig wallet. The authenticated user is always enrolled as an
 * initial signer (weight 1 unless they list themselves with another weight).
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await requireWalletActor(request)
    if ('response' in auth) return auth.response
    const { actor } = auth

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = createCollectiveWalletSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      )
    }

    const { name, threshold } = parsed.data

    const seen = new Set<string>()
    for (const signer of parsed.data.signers) {
      if (seen.has(signer.userId)) {
        return NextResponse.json(
          { error: `Duplicate signer: ${signer.userId}` },
          { status: 400 }
        )
      }
      seen.add(signer.userId)
    }

    const signers = seen.has(actor.id)
      ? parsed.data.signers
      : [{ userId: actor.id, weight: 1 }, ...parsed.data.signers]

    if (signers.length > MAX_SIGNERS) {
      return NextResponse.json(
        { error: `A wallet can have at most ${MAX_SIGNERS} signers` },
        { status: 400 }
      )
    }

    if (threshold < 1 || threshold > signers.length) {
      return NextResponse.json(
        {
          error: `threshold must be between 1 and the number of initial signers (${signers.length})`,
          details: { threshold, signerCount: signers.length },
        },
        { status: 400 }
      )
    }

    const otherSignerIds = signers.map((s) => s.userId).filter((id) => id !== actor.id)
    if (otherSignerIds.length > 0) {
      const found = await prisma.user.findMany({
        where: { id: { in: otherSignerIds } },
        select: { id: true },
      })
      const foundIds = new Set(found.map((u) => u.id))
      const missing = otherSignerIds.filter((id) => !foundIds.has(id))
      if (missing.length > 0) {
        return NextResponse.json(
          { error: 'One or more signers do not exist', details: { missingUserIds: missing } },
          { status: 400 }
        )
      }
    }

    const keys = resolveStellarKeys(parsed.data.stellarAddress, parsed.data.secretKey)
    if ('error' in keys) {
      return NextResponse.json({ error: keys.error }, { status: 400 })
    }

    const existing = await prisma.collectiveWallet.findUnique({
      where: { stellarAddress: keys.stellarAddress },
      select: { id: true },
    })
    if (existing) {
      return NextResponse.json(
        { error: 'A collective wallet with this Stellar address already exists' },
        { status: 409 }
      )
    }

    const wallet = await prisma.collectiveWallet.create({
      data: {
        name,
        threshold,
        stellarAddress: keys.stellarAddress,
        encryptedSecretKey: keys.secretKey ? encrypt(keys.secretKey) : null,
        signers: { create: signers.map((s) => ({ userId: s.userId, weight: s.weight })) },
      },
      select: WALLET_RESPONSE_SELECT,
    })

    logger.info(
      { walletId: wallet.id, creatorId: actor.id, signerCount: signers.length, threshold },
      'Collective wallet created'
    )

    return NextResponse.json({ wallet }, { status: 201 })
  } catch (error) {
    // Lost a race with a concurrent create for the same address.
    if (isUniqueConstraintError(error)) {
      return NextResponse.json(
        { error: 'A collective wallet with this Stellar address already exists' },
        { status: 409 }
      )
    }
    logger.error({ err: error }, 'POST /api/collective-wallets error')
    return NextResponse.json({ error: 'Failed to create collective wallet' }, { status: 500 })
  }
}
