import { NextRequest, NextResponse } from 'next/server'
import {
  BASE_FEE,
  Keypair,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { server, STELLAR_NETWORK } from '@/lib/stellar'
import { logger } from '@/lib/logger'

export interface StructuredClaimPredicate {
  unconditional?: boolean
  notBefore?: string | number
  absBefore?: string | number
  and?: StructuredClaimPredicate[]
  or?: StructuredClaimPredicate[]
  not?: StructuredClaimPredicate
}

/**
 * Evaluates a Stellar claim predicate against the authoritative server/ledger timestamp.
 * Client-supplied timestamps are never trusted.
 */
export function evaluatePredicateAtLedgerTime(
  predicate: StructuredClaimPredicate | null | undefined,
  ledgerTimeMs: number,
): { satisfied: boolean; reason?: string } {
  if (!predicate || predicate.unconditional === true) {
    return { satisfied: true }
  }

  if (predicate.notBefore !== undefined && predicate.notBefore !== null) {
    const unlockMs =
      typeof predicate.notBefore === 'number'
        ? predicate.notBefore
        : new Date(predicate.notBefore).getTime()
    if (!Number.isFinite(unlockMs) || ledgerTimeMs < unlockMs) {
      return {
        satisfied: false,
        reason: 'Claimable balance has not reached its unlock time yet',
      }
    }
  }

  if (predicate.absBefore !== undefined && predicate.absBefore !== null) {
    const expiryMs =
      typeof predicate.absBefore === 'number'
        ? predicate.absBefore
        : new Date(predicate.absBefore).getTime()
    if (!Number.isFinite(expiryMs) || ledgerTimeMs >= expiryMs) {
      return {
        satisfied: false,
        reason: 'Claimable balance claim window has expired',
      }
    }
  }

  if (predicate.not) {
    const inner = evaluatePredicateAtLedgerTime(predicate.not, ledgerTimeMs)
    if (inner.satisfied) {
      return {
        satisfied: false,
        reason: 'Claimable balance predicate (NOT condition) is not satisfied at current ledger time',
      }
    }
  }

  if (Array.isArray(predicate.and) && predicate.and.length > 0) {
    for (const child of predicate.and) {
      const res = evaluatePredicateAtLedgerTime(child, ledgerTimeMs)
      if (!res.satisfied) return res
    }
  }

  if (Array.isArray(predicate.or) && predicate.or.length > 0) {
    const anySatisfied = predicate.or.some(
      (child) => evaluatePredicateAtLedgerTime(child, ledgerTimeMs).satisfied,
    )
    if (!anySatisfied) {
      return {
        satisfied: false,
        reason: 'None of the OR claim predicate branches are satisfied at current ledger time',
      }
    }
  }

  return { satisfied: true }
}

async function fetchAuthoritativeLedgerTimeMs(): Promise<number> {
  try {
    const stellarServer = server as unknown as {
      ledgers?: () => {
        order: (dir: 'desc' | 'asc') => {
          limit: (n: number) => {
            call: () => Promise<{ records?: Array<{ closed_at?: string }> }>
          }
        }
      }
    }
    if (typeof stellarServer.ledgers === 'function') {
      const ledgerPage = await stellarServer
        .ledgers()
        .order('desc')
        .limit(1)
        .call()
      const closedAt = ledgerPage?.records?.[0]?.closed_at
      if (closedAt) {
        const parsed = new Date(closedAt).getTime()
        if (Number.isFinite(parsed)) return parsed
      }
    }
  } catch {
    // Fall back to authoritative server clock if Horizon ledger query is unavailable
  }
  return Date.now()
}

async function resolveCaller(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  const token = authHeader.slice(7).trim()
  if (!token) return null

  const claims = await verifyAuthToken(token)
  if (!claims) return null

  let userId = claims.userId
  let walletAddress: string | null = null

  if (typeof prisma.user?.findUnique === 'function') {
    const dbUser = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: {
        id: true,
        wallet: { select: { address: true } },
      },
    })
    if (dbUser) {
      userId = dbUser.id
      walletAddress = dbUser.wallet?.address ?? null
    }
  }

  return { userId, walletAddress }
}

/**
 * POST /api/stellar/claimable-balances/[id]/claim
 * Claims a matured Stellar claimable balance into the authenticated beneficiary's wallet.
 * - Verifies the unlock predicate server-side against current Horizon ledger time (ignoring client timestamps).
 * - Rejects claims when the mirror row's beneficiary does not match the caller (403).
 * - Submits the claimClaimableBalance operation to Horizon and marks the mirror row as claimed
 *   ONLY after Horizon confirms the transaction.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } | Promise<{ id: string }> },
) {
  try {
    const caller = await resolveCaller(req)
    if (!caller) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await Promise.resolve(params)
    const balanceId = id?.trim()
    if (!balanceId) {
      return NextResponse.json(
        { error: 'Claimable balance ID is required' },
        { status: 400 },
      )
    }

    const db = prisma as unknown as {
      claimableBalance?: {
        findUnique: (args: unknown) => Promise<Record<string, any> | null>
        update: (args: unknown) => Promise<Record<string, any>>
      }
      journalEntry?: {
        create: (args: unknown) => Promise<Record<string, any>>
      }
    }

    const mirrorRow = await db.claimableBalance?.findUnique({
      where: { id: balanceId },
    })

    if (!mirrorRow) {
      return NextResponse.json(
        { error: 'Claimable balance not found' },
        { status: 404 },
      )
    }

    const beneficiaryUserId =
      mirrorRow.beneficiaryUserId ?? mirrorRow.userId ?? null
    const beneficiaryWallet =
      mirrorRow.beneficiaryAddress ?? mirrorRow.claimantAddress ?? null

    const matchesUser =
      beneficiaryUserId && beneficiaryUserId === caller.userId
    const matchesWallet =
      !beneficiaryUserId &&
      beneficiaryWallet &&
      caller.walletAddress &&
      beneficiaryWallet === caller.walletAddress

    if (!matchesUser && !matchesWallet) {
      return NextResponse.json(
        {
          error:
            'Forbidden: You are not the beneficiary of this claimable balance',
        },
        { status: 403 },
      )
    }

    if (mirrorRow.status === 'claimed') {
      return NextResponse.json(
        {
          error: 'Claimable balance has already been claimed',
          code: 'ALREADY_CLAIMED',
          claimTxHash: mirrorRow.claimTxHash ?? null,
        },
        { status: 409 },
      )
    }

    // Always use authoritative ledger time from Horizon / server clock; ignore any client timestamp
    const ledgerTimeMs = await fetchAuthoritativeLedgerTimeMs()

    const predicate: StructuredClaimPredicate =
      mirrorRow.predicate ??
      (mirrorRow.unlockAt ? { notBefore: mirrorRow.unlockAt } : { unconditional: true })

    const evaluation = evaluatePredicateAtLedgerTime(predicate, ledgerTimeMs)
    if (!evaluation.satisfied) {
      return NextResponse.json(
        {
          error: evaluation.reason ?? 'Claim predicate not satisfied at current ledger time',
          code: 'PREDICATE_NOT_SATISFIED',
          ledgerTime: new Date(ledgerTimeMs).toISOString(),
        },
        { status: 422 },
      )
    }

    // Submit claimClaimableBalance to Horizon BEFORE updating the mirror row
    const onChainBalanceId: string =
      mirrorRow.balanceId ?? mirrorRow.stellarBalanceId ?? balanceId
    const claimantPublicKey: string =
      caller.walletAddress ??
      beneficiaryWallet ??
      Keypair.random().publicKey()

    const signerSecret =
      process.env.STELLAR_DELEGATED_SIGNER_SECRET ||
      process.env.STELLAR_FUNDING_WALLET_SECRET ||
      Keypair.random().secret()
    const signerKeypair = Keypair.fromSecret(signerSecret)

    const account = await server.loadAccount(claimantPublicKey)
    const fee =
      typeof server.fetchBaseFee === 'function'
        ? String(await server.fetchBaseFee())
        : String(BASE_FEE)

    const tx = new TransactionBuilder(account, {
      fee,
      networkPassphrase: STELLAR_NETWORK,
    })
      .addOperation(
        Operation.claimClaimableBalance({
          balanceId: onChainBalanceId,
          source: claimantPublicKey,
        }),
      )
      .setTimeout(30)
      .build()

    tx.sign(signerKeypair)
    const txResult = await server.submitTransaction(tx)

    const claimedAt = new Date(ledgerTimeMs)
    const updatedMirror = await db.claimableBalance!.update({
      where: { id: mirrorRow.id ?? balanceId },
      data: {
        status: 'claimed',
        claimedAt,
        claimTxHash: txResult.hash,
      },
    })

    if (typeof db.journalEntry?.create === 'function') {
      await db.journalEntry.create({
        data: {
          userId: caller.userId,
          debitAccount: 'claimable_balances_escrow',
          creditAccount: 'user_wallet_usdc',
          amount: mirrorRow.amount ?? '0',
          currency: mirrorRow.assetCode ?? 'USDC',
          description: `Claimed balance ${onChainBalanceId} (tx: ${txResult.hash})`,
          date: claimedAt,
        },
      })
    }

    logger?.info?.(
      {
        userId: caller.userId,
        balanceId,
        txHash: txResult.hash,
      },
      'POST /api/stellar/claimable-balances/[id]/claim succeeded',
    )

    return NextResponse.json({
      claimed: true,
      balanceId: updatedMirror.id ?? balanceId,
      stellarBalanceId: onChainBalanceId,
      txHash: txResult.hash,
      claimedAt: claimedAt.toISOString(),
      claimableBalance: updatedMirror,
    })
  } catch (err) {
    logger?.error?.(
      { err },
      'POST /api/stellar/claimable-balances/[id]/claim error',
    )
    return NextResponse.json(
      { error: 'Failed to claim Stellar claimable balance' },
      { status: 500 },
    )
  }
}
