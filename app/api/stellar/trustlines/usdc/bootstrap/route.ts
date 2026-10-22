import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import {
  Asset,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  Networks,
  Horizon,
} from '@stellar/stellar-sdk'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { verifyAuthToken } from '@/lib/auth'
import { HORIZON_URL, STELLAR_NETWORK } from '@/lib/stellar'

const bootstrapSchema = z.object({
  walletAddress: z
    .string()
    .trim()
    .refine((val) => StrKey.isValidEd25519PublicKey(val), 'Invalid Stellar public key address'),
})

const DEFAULT_USDC_ISSUER =
  process.env.NEXT_PUBLIC_USDC_ISSUER ||
  'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

async function getAuthenticatedUser(request: NextRequest): Promise<{ id: string; email: string } | null> {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null

  const claims = await verifyAuthToken(authToken)
  if (!claims?.userId) return null

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true, email: true },
  })

  return user
}

export function isRetryableHorizonError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null && 'response' in err) {
    const status = (err as { response?: { status?: number } }).response?.status
    if (status === 500 || status === 502 || status === 503 || status === 504 || status === 429) {
      return true
    }
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase()
    return (
      msg.includes('timeout') ||
      msg.includes('network') ||
      msg.includes('econnrefused') ||
      msg.includes('rate limit') ||
      msg.includes('busy')
    )
  }
  return true
}

/**
 * POST /api/stellar/trustlines/usdc/bootstrap
 *
 * Ensures a newly created embedded wallet carries the USDC trustline with sponsor-paid reserve.
 * - Submits changeTrust operation with sponsor-paid reserve so user never needs native XLM.
 * - Rejects bootstrap for wallets that already carry an active USDC trustline.
 * - Treats Horizon submission failures as retryable and stores an idempotent sentinel.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = bootstrapSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      )
    }

    const { walletAddress } = parsed.data
    const server = new Horizon.Server(HORIZON_URL)
    const usdcAsset = new Asset('USDC', DEFAULT_USDC_ISSUER)

    // 1. Check existing record or idempotent sentinel
    const existingBootstrap = await prisma.trustlineBootstrap.findUnique({
      where: { walletAddress },
    })

    if (existingBootstrap && existingBootstrap.status === 'success') {
      return NextResponse.json(
        {
          error: `Wallet ${walletAddress} already carries an active USDC trustline`,
          code: 'TRUSTLINE_ALREADY_EXISTS',
          txHash: existingBootstrap.txHash,
        },
        { status: 409 },
      )
    }

    // 2. Query on-chain Horizon account to check if trustline already exists
    try {
      const account = await server.loadAccount(walletAddress)
      const hasUsdc = account.balances.some(
        (b) =>
          b.asset_type !== 'native' &&
          (b as Horizon.HorizonApi.BalanceLineAsset).asset_code === 'USDC' &&
          (b as Horizon.HorizonApi.BalanceLineAsset).asset_issuer === DEFAULT_USDC_ISSUER,
      )

      if (hasUsdc) {
        if (existingBootstrap) {
          await prisma.trustlineBootstrap.update({
            where: { walletAddress },
            data: { status: 'success' },
          })
        } else {
          await prisma.trustlineBootstrap.create({
            data: {
              walletAddress,
              userId: user.id,
              assetCode: 'USDC',
              issuerAddress: DEFAULT_USDC_ISSUER,
              status: 'success',
            },
          })
        }
        return NextResponse.json(
          {
            error: `Wallet ${walletAddress} already carries an active USDC trustline`,
            code: 'TRUSTLINE_ALREADY_EXISTS',
          },
          { status: 409 },
        )
      }
    } catch (loadErr: unknown) {
      // If account not found or network error, let subsequent submission handle
      logger.warn({ walletAddress, err: loadErr }, 'Horizon account preflight check warning')
    }

    // 3. Obtain sponsor keypair
    const sponsorSecret =
      process.env.STELLAR_SPONSOR_SECRET ||
      process.env.STELLAR_FUNDING_SECRET ||
      Keypair.random().secret()
    const sponsorKeypair = Keypair.fromSecret(sponsorSecret)

    // Upsert sentinel before submission
    const sentinel = await prisma.trustlineBootstrap.upsert({
      where: { walletAddress },
      create: {
        walletAddress,
        userId: user.id,
        assetCode: 'USDC',
        issuerAddress: DEFAULT_USDC_ISSUER,
        status: 'pending',
        sponsoredById: sponsorKeypair.publicKey(),
        retryCount: 0,
      },
      update: {
        status: 'pending',
        retryCount: { increment: 1 },
        lastAttemptAt: new Date(),
      },
    })

    try {
      // Load sponsor account to build transaction
      const sponsorAccount = await server.loadAccount(sponsorKeypair.publicKey())

      // Build sponsored change trust transaction:
      // Begin sponsoring -> Change trust on wallet -> End sponsoring
      const tx = new TransactionBuilder(sponsorAccount, {
        fee: '100',
        networkPassphrase: STELLAR_NETWORK,
      })
        .addOperation(
          Operation.beginSponsoringFutureReserves({
            sponsoredId: walletAddress,
          }),
        )
        .addOperation(
          Operation.changeTrust({
            asset: usdcAsset,
            source: walletAddress,
          }),
        )
        .addOperation(
          Operation.endSponsoringFutureReserves({
            source: walletAddress,
          }),
        )
        .setTimeout(30)
        .build()

      // Sign transaction with sponsor keypair
      tx.sign(sponsorKeypair)

      const submission = await server.submitTransaction(tx)
      const txHash = (submission as any).hash || tx.hash().toString('hex')

      const updated = await prisma.trustlineBootstrap.update({
        where: { walletAddress },
        data: {
          status: 'success',
          txHash,
          error: null,
        },
      })

      logger.info(
        { walletAddress, txHash, sponsoredBy: sponsorKeypair.publicKey() },
        'USDC trustline successfully bootstrapped with sponsor reserve',
      )

      return NextResponse.json(
        {
          success: true,
          walletAddress,
          asset: 'USDC',
          issuer: DEFAULT_USDC_ISSUER,
          txHash,
          sponsoredBy: sponsorKeypair.publicKey(),
        },
        { status: 201 },
      )
    } catch (subErr: any) {
      const isRetryable = isRetryableHorizonError(subErr)
      const errMsg = subErr?.message || 'Horizon transaction submission failure'

      // Leave idempotent sentinel marked with retryable failure
      await prisma.trustlineBootstrap.update({
        where: { walletAddress },
        data: {
          status: 'retryable_failure',
          error: errMsg,
        },
      })

      logger.error(
        { walletAddress, isRetryable, err: subErr },
        'Horizon trustline bootstrap failed (sentinel saved for retry)',
      )

      return NextResponse.json(
        {
          error: 'Horizon trustline submission failed; marked as retryable',
          code: 'HORIZON_SUBMISSION_RETRYABLE',
          retryable: isRetryable,
          sentinelId: sentinel.id,
          retryCount: sentinel.retryCount + 1,
          details: errMsg,
        },
        { status: 503 },
      )
    }
  } catch (error) {
    logger.error({ err: error }, 'POST /api/stellar/trustlines/usdc/bootstrap error')
    return NextResponse.json({ error: 'Failed to bootstrap trustline' }, { status: 500 })
  }
}
