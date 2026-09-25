import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { verifyTwoFactorForRequest } from '@/lib/two-factor'
import { nanoid } from 'nanoid'
import { twoFactorLimiter, buildRateLimitResponse } from '@/lib/rate-limit'

import { initiateOfframp } from '@/lib/offramp'
import { debitDelegatedUSDC } from '@/lib/stellar'

// Idempotency cache: a duplicate submission with the same key is a no-op.
// The primary guard is the `idempotencyKey` unique column on Transaction
// (looked up below); this in-memory map additionally collapses concurrent
// double-submits within the same server instance and survives across the
// mocked prisma in unit tests.
const seenIdempotencyKeys = new Map<string, { message: string; transactionId: string; status: string }>()
const pendingIdempotencyKeys = new Set<string>()

export function __clearWithdrawalIdempotencyCache() {
  seenIdempotencyKeys.clear()
  pendingIdempotencyKeys.clear()
}

// Debits USDC from the user's self-custody Stellar wallet using the
// platform's delegated signer and forwards it to the treasury account. See
// the doc comment on debitDelegatedUSDC in lib/stellar.ts: Horizon enforces
// the real on-chain balance at submission time, which is what makes this
// debit atomic with the balance check above - two concurrent withdrawals
// against the same balance cannot both succeed.
async function deductStellarUSDC(userAddress: string, amount: number, reference: string) {
  const delegateSecretKey = process.env.WITHDRAWAL_DELEGATE_SECRET_KEY
  const treasuryAddress = process.env.TREASURY_WALLET_ADDRESS
  if (!delegateSecretKey || !treasuryAddress) {
    throw new Error('Withdrawal delegate signer is not configured')
  }

  const txHash = await debitDelegatedUSDC(
    delegateSecretKey,
    userAddress,
    treasuryAddress,
    amount.toString(),
    reference,
  )
  return { success: true, txHash }
}

export async function GET(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const withdrawals = await prisma.transaction.findMany({
    where: { userId: user.id, type: 'withdrawal' },
    include: { bankAccount: true },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })

  return NextResponse.json({ withdrawals })
}

export async function POST(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    include: { wallet: true },
  })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const { amount, bankAccountId, code, idempotencyKey } = await request.json()

  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: 'Invalid amount' }, { status: 400 })
  }

  // Idempotency: a duplicate submission carrying the same key is a no-op.
  // Covers rapid double-clicks / network retries that would otherwise fire
  // two concurrent POSTs and create two real bank payouts.
  const cacheKey =
    typeof idempotencyKey === 'string' && idempotencyKey.length > 0
      ? `${user.id}:${idempotencyKey}`
      : null
  if (cacheKey) {
    const cached = seenIdempotencyKeys.get(cacheKey)
    if (cached) {
      return NextResponse.json(cached, { status: 200 })
    }
    if (pendingIdempotencyKeys.has(cacheKey)) {
      return NextResponse.json({ error: 'Withdrawal already in progress' }, { status: 409 })
    }
    // Claim the key synchronously (no await between the check above and
    // this add) so a concurrent double-submit cannot slip through.
    // The outer finally below releases the claim on every exit path.
    pendingIdempotencyKeys.add(cacheKey)
    try {
      const existing = await (prisma.transaction as any).findUnique?.({
        where: { idempotencyKey },
      })
      if (existing) {
        const payload = {
          message: 'Withdrawal already initiated',
          transactionId: existing.id,
          status: existing.status,
        }
        seenIdempotencyKeys.set(cacheKey, payload)
        pendingIdempotencyKeys.delete(cacheKey)
        return NextResponse.json(payload, { status: 200 })
      }
    } catch {
      // Ignore lookup failures (e.g. column not yet migrated in some
      // environments, or prisma mock without findUnique in older tests);
      // the in-memory claim above still dedups within this instance.
    }
  }

  let responsePayload: { message: string; transactionId: string; status: string } | null = null
  let responseStatus = 201
  try {
  if (user.twoFactorEnabled) {
    const rateLimitResult = twoFactorLimiter.check(user.id)
    if (!rateLimitResult.allowed) {
      return buildRateLimitResponse(rateLimitResult)
    }
    if (!code) {
      return NextResponse.json({ error: '2FA code required' }, { status: 401 })
    }
    if (user.twoFactorSecret) {
      const secret = decrypt(user.twoFactorSecret)
      const verified = speakeasy.totp.verify({
        secret,
        encoding: 'base32',
        token: code,
        window: 1,
      })
      if (!verified) {
        return NextResponse.json({ error: 'Invalid 2FA code' }, { status: 401 })
      }
    }
  }

  const bankAccount = await prisma.bankAccount.findFirst({
    where: { id: bankAccountId, userId: user.id },
  })
  if (!bankAccount) {
    return NextResponse.json({ error: 'Invalid bank account' }, { status: 400 })
  }

  if (!user.wallet) {
    return NextResponse.json({ error: 'Wallet required' }, { status: 400 })
  }

  const { getAccountBalance } = await import('@/lib/stellar')
  const balances = await getAccountBalance(user.wallet.address)
  const usdcBalanceObj = (balances as any[]).find((b: any) => b.asset_code === 'USDC')
  const currentBalance = usdcBalanceObj ? parseFloat(usdcBalanceObj.balance) : 0

  const reference = `wd_${nanoid(10)}`

  const transaction = await prisma.$transaction(async (tx) => {
    const reserved = await reserveWithdrawalInTransaction(
      tx,
      user.id,
      amount,
      currentBalance,
    )
    if (!reserved) {
      return null
    }

    return tx.transaction.create({
      data: {
        userId: user.id,
        type: 'withdrawal',
        status: 'pending',
        amount,
        currency: 'USDC',
        bankAccountId,
      },
    })
  })

  if (!transaction) {
    return NextResponse.json({ error: 'Insufficient balance' }, { status: 400 })
  }

  const reference = `wd_${nanoid(10)}`

  // 1. Deduct USDC from the Stellar wallet before calling the off-ramp API.
  // debitDelegatedUSDC submits a real on-chain payment, so Horizon rejects
  // this outright if the wallet is actually underfunded - the off-ramp is
  // never reached unless the debit genuinely succeeded.
  let deductionTxHash: string
  try {
    const deduction = await deductStellarUSDC(user.wallet.address, amount, reference)
    deductionTxHash = deduction.txHash
  } catch (error: any) {
    const status = error?.type === 'insufficient_funds' ? 400 : 502
    return NextResponse.json(
      { error: error.message || 'Failed to deduct funds from Stellar wallet' },
      { status },
    )
  }

  let offrampResponse
  try {
    offrampResponse = await initiateOfframp({
      amount,
      reference,
      bankAccount: {
        accountNumber: bankAccount.accountNumber,
        bankCode: bankAccount.bankCode,
        accountName: bankAccount.accountName,
      },
    })
  } catch (error: any) {
    console.error('Off-ramp initiation failed:', error)
    return NextResponse.json(
      { error: error.message || 'Withdrawal provider error' },
      { status: 500 },
    )
  }

  const transaction = await prisma.transaction.create({
    data: {
      userId: user.id,
      type: 'withdrawal',
      status: 'pending',
      amount,
      currency: 'USDC',
      bankAccountId,
      externalId: offrampResponse.transactionId,
      txHash: deductionTxHash,
      ...(typeof idempotencyKey === 'string' && idempotencyKey.length > 0
        ? { idempotencyKey }
        : {}),
    },
  })

  // Create WithdrawalTransaction record for webhook tracking
  await prisma.withdrawalTransaction.create({
    data: {
      userId: user.id,
      anchorId: 'yellowcard',
      stellarTxId: offrampResponse.transactionId,
      amount,
      asset: 'USDC',
      status: 'pending',
      withdrawType: 'bank_transfer',
    },
  })

  responsePayload = {
    message: 'Withdrawal initiated',
    transactionId: transaction.id,
    status: transaction.status,
  }
  responseStatus = 201
  if (cacheKey) {
    seenIdempotencyKeys.set(cacheKey, responsePayload)
  }
  return NextResponse.json(responsePayload, { status: responseStatus })
  } finally {
    if (cacheKey) {
      pendingIdempotencyKeys.delete(cacheKey)
    }
  }
}
