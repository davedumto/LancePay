import { NextRequest, NextResponse } from 'next/server'
import {
  BASE_FEE,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
} from '@stellar/stellar-sdk'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { server, STELLAR_NETWORK, USDC_ASSET } from '@/lib/stellar'
import { logger } from '@/lib/logger'

async function resolveUserAndWallet(req: NextRequest) {
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
 * POST /api/stellar/trustlines/usdc/bootstrap
 * Bootstraps the USDC trustline for a newly provisioned embedded wallet using
 * CAP-0033 sponsored reserves so the user wallet never needs native XLM.
 * - Rejects wallets that already carry an active USDC trustline with 409.
 * - Leaves an idempotent sentinel row when Horizon submission fails so retries
 *   can resume cleanly from the same state.
 */
export async function POST(req: NextRequest) {
  try {
    const caller = await resolveUserAndWallet(req)
    if (!caller) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let body: Record<string, unknown> = {}
    try {
      const raw = await req.text()
      if (raw.trim()) {
        body = JSON.parse(raw) as Record<string, unknown>
      }
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const walletAddress =
      (typeof body.walletAddress === 'string' && body.walletAddress.trim()) ||
      caller.walletAddress ||
      ''

    if (!walletAddress || !StrKey.isValidEd25519PublicKey(walletAddress)) {
      return NextResponse.json(
        { error: 'Valid Stellar walletAddress is required' },
        { status: 400 },
      )
    }

    if (
      caller.walletAddress &&
      walletAddress !== caller.walletAddress
    ) {
      return NextResponse.json(
        { error: 'Forbidden: walletAddress does not belong to authenticated user' },
        { status: 403 },
      )
    }

    const walletAccount = await server.loadAccount(walletAddress)
    const usdcCode = USDC_ASSET.getCode()
    const usdcIssuer = USDC_ASSET.getIssuer()

    const hasUsdcTrustline = Array.isArray(walletAccount.balances) &&
      walletAccount.balances.some(
        (b: { asset_type?: string; asset_code?: string; asset_issuer?: string }) =>
          b.asset_type !== 'native' &&
          b.asset_code === usdcCode &&
          b.asset_issuer === usdcIssuer,
      )

    if (hasUsdcTrustline) {
      return NextResponse.json(
        {
          error: 'Wallet already has an active USDC trustline',
          code: 'USDC_TRUSTLINE_ALREADY_EXISTS',
          walletAddress,
        },
        { status: 409 },
      )
    }

    const idempotencyKey = `usdc-trustline:${walletAddress}`
    const db = prisma as unknown as {
      trustlineBootstrap?: {
        findUnique: (args: unknown) => Promise<Record<string, any> | null>
        upsert: (args: unknown) => Promise<Record<string, any>>
      }
    }

    const existingSentinel = await db.trustlineBootstrap?.findUnique({
      where: { walletAddress },
    })

    const nextAttempt = Number(existingSentinel?.attemptCount ?? 0) + 1

    const sponsorSecret =
      process.env.STELLAR_FUNDING_WALLET_SECRET || Keypair.random().secret()
    const sponsorKeypair = Keypair.fromSecret(sponsorSecret)
    const sponsorPublicKey = sponsorKeypair.publicKey()

    const sponsorAccount = await server.loadAccount(sponsorPublicKey)
    const fee =
      typeof server.fetchBaseFee === 'function'
        ? String(await server.fetchBaseFee())
        : String(BASE_FEE)

    // Build CAP-0033 sponsored reserve sandwich around changeTrust
    const tx = new TransactionBuilder(sponsorAccount, {
      fee,
      networkPassphrase: STELLAR_NETWORK,
    })
      .addOperation(
        Operation.beginSponsoringFutureReserves({
          sponsoredId: walletAddress,
          source: sponsorPublicKey,
        }),
      )
      .addOperation(
        Operation.changeTrust({
          asset: USDC_ASSET,
          source: walletAddress,
        }),
      )
      .addOperation(
        Operation.endSponsoringFutureReserves({
          source: walletAddress,
        }),
      )
      .setTimeout(60)
      .build()

    tx.sign(sponsorKeypair)

    try {
      const txResult = await server.submitTransaction(tx)

      const sentinel = await db.trustlineBootstrap?.upsert({
        where: { walletAddress },
        create: {
          userId: caller.userId,
          walletAddress,
          assetCode: usdcCode,
          assetIssuer: usdcIssuer,
          sponsorAccount: sponsorPublicKey,
          idempotencyKey,
          status: 'completed',
          attemptCount: nextAttempt,
          txHash: txResult.hash,
          lastError: null,
        },
        update: {
          status: 'completed',
          attemptCount: nextAttempt,
          txHash: txResult.hash,
          lastError: null,
        },
      })

      logger?.info?.(
        {
          userId: caller.userId,
          walletAddress,
          txHash: txResult.hash,
          attemptCount: nextAttempt,
        },
        'POST /api/stellar/trustlines/usdc/bootstrap succeeded',
      )

      return NextResponse.json(
        {
          bootstrapped: true,
          walletAddress,
          sponsorAccount: sponsorPublicKey,
          asset: { code: usdcCode, issuer: usdcIssuer },
          txHash: txResult.hash,
          idempotencyKey,
          attemptCount: nextAttempt,
          sentinel: sentinel ?? null,
        },
        { status: 201 },
      )
    } catch (submitErr) {
      const errorMessage =
        submitErr instanceof Error
          ? submitErr.message
          : 'Horizon submission failed'

      const sentinel = await db.trustlineBootstrap?.upsert({
        where: { walletAddress },
        create: {
          userId: caller.userId,
          walletAddress,
          assetCode: usdcCode,
          assetIssuer: usdcIssuer,
          sponsorAccount: sponsorPublicKey,
          idempotencyKey,
          status: 'retry_pending',
          attemptCount: nextAttempt,
          txHash: null,
          lastError: errorMessage,
        },
        update: {
          status: 'retry_pending',
          attemptCount: nextAttempt,
          lastError: errorMessage,
        },
      })

      logger?.warn?.(
        {
          err: submitErr,
          userId: caller.userId,
          walletAddress,
          idempotencyKey,
          attemptCount: nextAttempt,
        },
        'POST /api/stellar/trustlines/usdc/bootstrap failed; sentinel recorded for retry',
      )

      return NextResponse.json(
        {
          error: errorMessage,
          code: 'HORIZON_SUBMISSION_RETRYABLE',
          retryable: true,
          idempotencyKey,
          walletAddress,
          attemptCount: nextAttempt,
          sentinel: sentinel ?? {
            walletAddress,
            idempotencyKey,
            status: 'retry_pending',
            attemptCount: nextAttempt,
            lastError: errorMessage,
          },
        },
        { status: 503 },
      )
    }
  } catch (err) {
    logger?.error?.(
      { err },
      'POST /api/stellar/trustlines/usdc/bootstrap error',
    )
    return NextResponse.json(
      { error: 'Failed to bootstrap USDC trustline' },
      { status: 500 },
    )
  }
}
