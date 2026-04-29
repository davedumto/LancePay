import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { classifyWalletError } from '../_lib/wallet-errors'

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
import { swrGet, swrSet, swrIsFresh, swrIsStale } from '../_lib/swr-cache'

const FRESH_MS = 15_000 // 15 s: serve from cache, no upstream call
const STALE_MS = 60_000 // 60 s: serve stale + revalidate in background

type WalletPayload = { id: string; stellarAddress: string; createdAt: Date } | null

async function fetchWalletFromDb(userId: string): Promise<WalletPayload> {
  const wallet = await prisma.wallet.findUnique({ where: { userId } })
  if (!wallet) return null
  return { id: wallet.id, stellarAddress: wallet.address, createdAt: wallet.createdAt }
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

  const cacheKey = `wallet:${user.id}`
  const cached = swrGet<WalletPayload>(cacheKey)

  if (cached) {
    if (swrIsFresh(cached)) {
      // Within the fresh window — return immediately, no upstream call
      return NextResponse.json({ wallet: cached.value })
    }

    if (swrIsStale(cached)) {
      // Within the stale window — return the cached value and revalidate in background
      setImmediate(async () => {
        try {
          const fresh = await fetchWalletFromDb(user.id)
          swrSet(cacheKey, fresh, FRESH_MS, STALE_MS)
        } catch {
          // Keep serving the last known value; do not evict
        }
      })

      const headers = new Headers()
      headers.set('X-Cache', 'STALE')
      return NextResponse.json({ wallet: cached.value }, { headers })
    }
  }

  const startedAt = Date.now()
  const attempt = 1
  try {
    const balance = await fetchWalletBalance(wallet.address)
    return NextResponse.json({
      wallet: {
        id: wallet.id,
        stellarAddress: wallet.address,
        balance,
        createdAt: wallet.createdAt,
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
  // Cache miss or beyond stale window — synchronous upstream fetch
  try {
    const wallet = await fetchWalletFromDb(user.id)
    swrSet(cacheKey, wallet, FRESH_MS, STALE_MS)
    return NextResponse.json({ wallet })
  } catch (error) {
    // If we still have a (now-expired) value fall back to it rather than hard-failing
    const stale = swrGet<WalletPayload>(cacheKey)
    if (stale) {
      const headers = new Headers()
      headers.set('X-Cache', 'STALE')
      return NextResponse.json({ wallet: stale.value }, { headers })
    }
    return NextResponse.json({ error: 'Failed to fetch wallet' }, { status: 500 })
  }
}
