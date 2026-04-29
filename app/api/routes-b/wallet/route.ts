import { withRequestId } from '../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { swrGet, swrSet, swrIsFresh, swrIsStale } from '../_lib/swr-cache'
import { classifyWalletError } from '../_lib/wallet-errors'

const FRESH_MS = 15_000
const STALE_MS = 60_000

type WalletPayload = {
  id: string
  stellarAddress: string
  balance?: number | null
  createdAt: Date
} | null

async function fetchWalletBalance(address: string): Promise<number | null> {
  const statusUrl = process.env.CHAIN_RPC_WALLET_BALANCE_URL
  if (!statusUrl) {
    return null
  }

  const response = await fetch(statusUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address }),
    cache: 'no-store',
  })

  if (!response.ok) {
    const error = new Error(`Upstream wallet balance failed with status ${response.status}`) as Error & { status?: number }
    error.status = response.status
    throw error
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error('Invalid response schema from wallet balance upstream')
  }

  const balance = (payload as { balance?: unknown }).balance
  if (balance === undefined || balance === null) {
    throw new Error('Schema mismatch: missing balance')
  }

  const parsed = Number(balance)
  if (!Number.isFinite(parsed)) {
    throw new Error('Schema mismatch: invalid balance format')
  }

  return parsed
}

async function fetchWalletFromDb(userId: string): Promise<WalletPayload> {
  const wallet = await prisma.wallet.findUnique({ where: { userId } })
  if (!wallet) return null

  return {
    id: wallet.id,
    stellarAddress: wallet.address,
    createdAt: wallet.createdAt,
  }
}

async function GETHandler(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')

  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const cacheKey = `wallet:${user.id}`
  const cached = swrGet<WalletPayload>(cacheKey)

  if (cached) {
    if (swrIsFresh(cached)) {
      return NextResponse.json({ wallet: cached.value })
    }

    if (swrIsStale(cached)) {
      const headers = new Headers()
      headers.set('X-Cache', 'STALE')
      return NextResponse.json({ wallet: cached.value }, { headers })
    }
  }

  let wallet: WalletPayload
  try {
    wallet = await fetchWalletFromDb(user.id)
    swrSet(cacheKey, wallet, FRESH_MS, STALE_MS)
  } catch {
    const stale = swrGet<WalletPayload>(cacheKey)
    if (stale) {
      const headers = new Headers()
      headers.set('X-Cache', 'STALE')
      return NextResponse.json({ wallet: stale.value }, { headers })
    }
    return NextResponse.json({ wallet: null }, { status: 200 })
  }

  if (!wallet || !(request instanceof NextRequest) || !process.env.CHAIN_RPC_WALLET_BALANCE_URL) {
    return NextResponse.json({ wallet })
  }

  const startedAt = Date.now()
  const attempt = 1
  try {
    const balance = await fetchWalletBalance(wallet.stellarAddress)
    return NextResponse.json({
      wallet: {
        ...wallet,
        balance,
      },
    })
  } catch (error) {
    const failure = classifyWalletError(error)
    logger.error(
      {
        userId: user.id,
        attempt,
        durationMs: Date.now() - startedAt,
        errorClass: failure.errorClass,
      },
      'routes-b wallet GET upstream failure',
    )

    return NextResponse.json(
      {
        error: 'Wallet balance temporarily unavailable',
        code: failure.code,
      },
      { status: failure.status },
    )
  }
}

export const GET = withRequestId(GETHandler)
