import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import {
  BASE_FEE,
  Claimant,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { server, STELLAR_NETWORK, USDC_ASSET } from '@/lib/stellar'
import { logger } from '@/lib/logger'

export const MAX_CLAIMANTS_PER_BALANCE = 10

export interface StructuredPredicateInput {
  type?: 'unconditional' | 'time_locked' | 'before_absolute_time' | 'window'
  unlockAt?: string | number
  expiresAt?: string | number
}

export interface ClaimantInput {
  destination: string
  beneficiaryUserId?: string
  predicate?: StructuredPredicateInput
  rawXdr?: unknown
  predicateXdr?: unknown
}

/**
 * Encodes a structured unlock predicate into a Stellar xdr.ClaimPredicate.
 * Never accepts raw XDR from the caller.
 */
export function buildClaimPredicateFromStructured(
  input?: StructuredPredicateInput,
): xdr.ClaimPredicate {
  if (!input || input.type === 'unconditional') {
    return Claimant.predicateUnconditional()
  }

  let notBeforeSec: string | null = null
  let absBeforeSec: string | null = null

  if (input.unlockAt !== undefined && input.unlockAt !== null) {
    const ms =
      typeof input.unlockAt === 'number'
        ? input.unlockAt
        : new Date(input.unlockAt).getTime()
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new Error('Invalid unlockAt timestamp in structured predicate')
    }
    notBeforeSec = String(Math.floor(ms / 1000))
  }

  if (input.expiresAt !== undefined && input.expiresAt !== null) {
    const ms =
      typeof input.expiresAt === 'number'
        ? input.expiresAt
        : new Date(input.expiresAt).getTime()
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new Error('Invalid expiresAt timestamp in structured predicate')
    }
    absBeforeSec = String(Math.floor(ms / 1000))
  }

  if (notBeforeSec && absBeforeSec) {
    if (BigInt(absBeforeSec) <= BigInt(notBeforeSec)) {
      throw new Error('expiresAt must be strictly after unlockAt')
    }
    return Claimant.predicateAnd(
      Claimant.predicateNot(Claimant.predicateBeforeAbsoluteTime(notBeforeSec)),
      Claimant.predicateBeforeAbsoluteTime(absBeforeSec),
    )
  }

  if (notBeforeSec) {
    return Claimant.predicateNot(
      Claimant.predicateBeforeAbsoluteTime(notBeforeSec),
    )
  }

  if (absBeforeSec) {
    return Claimant.predicateBeforeAbsoluteTime(absBeforeSec)
  }

  return Claimant.predicateUnconditional()
}

async function resolveCaller(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  const token = authHeader.slice(7).trim()
  if (!token) return null

  const claims = await verifyAuthToken(token)
  if (!claims) return null

  let userId = claims.userId
  if (typeof prisma.user?.findUnique === 'function') {
    const dbUser = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })
    if (dbUser?.id) userId = dbUser.id
  }

  return { userId }
}

/**
 * POST /api/stellar/claimable-balances/create
 * Creates a Stellar claimable balance for a time-locked payout or invoice.
 * - Rejects raw XDR predicate inputs and encodes predicates strictly from structured fields.
 * - Enforces MAX_CLAIMANTS_PER_BALANCE (10) so predicate size is bounded.
 * - Persists a mirror row linking the resulting balanceId back to the originating invoiceId or payoutId.
 */
export async function POST(req: NextRequest) {
  try {
    const caller = await resolveCaller(req)
    if (!caller) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let body: Record<string, unknown>
    try {
      body = (await req.json()) as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    // Explicitly reject raw XDR predicate inputs
    if (
      body.rawXdr !== undefined ||
      body.predicateXdr !== undefined ||
      body.xdr !== undefined
    ) {
      return NextResponse.json(
        {
          error:
            'Raw XDR predicates are not permitted; provide a structured predicate definition',
          code: 'RAW_XDR_REJECTED',
        },
        { status: 400 },
      )
    }

    const invoiceId =
      typeof body.invoiceId === 'string' && body.invoiceId.trim()
        ? body.invoiceId.trim()
        : null
    const payoutId =
      typeof body.payoutId === 'string' && body.payoutId.trim()
        ? body.payoutId.trim()
        : null

    if (!invoiceId && !payoutId) {
      return NextResponse.json(
        {
          error:
            'Either invoiceId or payoutId is required to link the claimable balance mirror row',
        },
        { status: 400 },
      )
    }

    const amountNum = Number(body.amount)
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return NextResponse.json(
        { error: 'amount must be a positive number' },
        { status: 400 },
      )
    }
    const amountStr = amountNum.toFixed(7).replace(/\.?0+$/, '') || String(amountNum)

    if (!Array.isArray(body.claimants) || body.claimants.length === 0) {
      return NextResponse.json(
        { error: 'claimants must be a non-empty array' },
        { status: 400 },
      )
    }

    if (body.claimants.length > MAX_CLAIMANTS_PER_BALANCE) {
      return NextResponse.json(
        {
          error: `claimants count (${body.claimants.length}) exceeds maximum of ${MAX_CLAIMANTS_PER_BALANCE}`,
          code: 'MAX_CLAIMANTS_EXCEEDED',
        },
        { status: 400 },
      )
    }

    const stellarClaimants: Claimant[] = []
    const normalizedClaimants: Array<{
      destination: string
      beneficiaryUserId: string | null
      predicate: StructuredPredicateInput
    }> = []

    for (const rawClaimant of body.claimants as ClaimantInput[]) {
      if (
        !rawClaimant ||
        typeof rawClaimant !== 'object' ||
        rawClaimant.rawXdr !== undefined ||
        rawClaimant.predicateXdr !== undefined
      ) {
        return NextResponse.json(
          {
            error:
              'Raw XDR predicates on claimants are not permitted; use structured predicate fields',
            code: 'RAW_XDR_REJECTED',
          },
          { status: 400 },
        )
      }

      const destination =
        typeof rawClaimant.destination === 'string'
          ? rawClaimant.destination.trim()
          : ''
      if (!StrKey.isValidEd25519PublicKey(destination)) {
        return NextResponse.json(
          { error: `Invalid claimant Stellar address: ${destination}` },
          { status: 400 },
        )
      }

      let xdrPredicate: xdr.ClaimPredicate
      try {
        xdrPredicate = buildClaimPredicateFromStructured(rawClaimant.predicate)
      } catch (predErr) {
        return NextResponse.json(
          {
            error:
              predErr instanceof Error
                ? predErr.message
                : 'Invalid structured predicate',
          },
          { status: 400 },
        )
      }

      stellarClaimants.push(new Claimant(destination, xdrPredicate))
      normalizedClaimants.push({
        destination,
        beneficiaryUserId: rawClaimant.beneficiaryUserId ?? null,
        predicate: rawClaimant.predicate ?? { type: 'unconditional' },
      })
    }

    const sourceSecret =
      process.env.STELLAR_FUNDING_WALLET_SECRET || Keypair.random().secret()
    const sourceKeypair = Keypair.fromSecret(sourceSecret)
    const sourceAccount = await server.loadAccount(sourceKeypair.publicKey())
    const fee =
      typeof server.fetchBaseFee === 'function'
        ? String(await server.fetchBaseFee())
        : String(BASE_FEE)

    const tx = new TransactionBuilder(sourceAccount, {
      fee,
      networkPassphrase: STELLAR_NETWORK,
    })
      .addOperation(
        Operation.createClaimableBalance({
          asset: USDC_ASSET,
          amount: amountNum.toFixed(2),
          claimants: stellarClaimants,
        }),
      )
      .setTimeout(30)
      .build()

    tx.sign(sourceKeypair)
    const txResult = (await server.submitTransaction(tx)) as {
      hash: string
      balanceId?: string
    }

    const derivedBalanceId =
      txResult.balanceId ??
      `00000000${crypto
        .createHash('sha256')
        .update(`${txResult.hash}:0`)
        .digest('hex')}`

    const db = prisma as unknown as {
      claimableBalance: {
        create: (args: unknown) => Promise<Record<string, unknown>>
      }
    }

    const primaryClaimant = normalizedClaimants[0]
    const mirrorRow = await db.claimableBalance.create({
      data: {
        balanceId: derivedBalanceId,
        userId: caller.userId,
        beneficiaryUserId: primaryClaimant.beneficiaryUserId,
        beneficiaryAddress: primaryClaimant.destination,
        invoiceId,
        payoutId,
        amount: amountStr,
        assetCode: USDC_ASSET.getCode(),
        claimants: normalizedClaimants,
        predicate: primaryClaimant.predicate,
        status: 'pending',
        txHash: txResult.hash,
      },
    })

    logger?.info?.(
      {
        userId: caller.userId,
        balanceId: derivedBalanceId,
        invoiceId,
        payoutId,
        txHash: txResult.hash,
      },
      'POST /api/stellar/claimable-balances/create succeeded',
    )

    return NextResponse.json(
      {
        balanceId: derivedBalanceId,
        txHash: txResult.hash,
        invoiceId,
        payoutId,
        claimantCount: normalizedClaimants.length,
        mirror: mirrorRow,
      },
      { status: 201 },
    )
  } catch (err) {
    logger?.error?.({ err }, 'POST /api/stellar/claimable-balances/create error')
    return NextResponse.json(
      { error: 'Failed to create Stellar claimable balance' },
      { status: 500 },
    )
  }
}
