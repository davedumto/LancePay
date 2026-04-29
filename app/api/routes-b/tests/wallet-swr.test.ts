import { describe, it, expect, vi, beforeEach } from 'vitest'
import { swrGet, swrSet, swrClear, swrIsFresh, swrIsStale, type SwrEntry } from '../_lib/swr-cache'

// ── swr-cache unit tests ──────────────────────────────────────────────────────

describe('swr-cache', () => {
  beforeEach(() => swrClear())

  it('returns null on cold miss', () => {
    expect(swrGet('missing')).toBeNull()
  })

  it('returns entry immediately after set', () => {
    swrSet('k', 'value', 15_000, 60_000)
    const entry = swrGet<string>('k')
    expect(entry).not.toBeNull()
    expect(entry!.value).toBe('value')
  })

  it('fresh hit: swrIsFresh returns true within freshMs', () => {
    swrSet('k', 42, 15_000, 60_000)
    const entry = swrGet<number>('k')!
    expect(swrIsFresh(entry)).toBe(true)
    expect(swrIsStale(entry)).toBe(false)
  })

  it('stale hit: swrIsStale returns true after freshMs but before staleMs', () => {
    const now = Date.now()
    swrSet('k', 'val', 0, 60_000) // freshMs = 0 so already stale
    const entry = swrGet<string>('k')!
    // Force freshUntil into the past
    entry.freshUntil = now - 1
    entry.staleUntil = now + 60_000
    expect(swrIsFresh(entry)).toBe(false)
    expect(swrIsStale(entry)).toBe(true)
  })

  it('beyond-stale: swrGet returns null after staleMs expires', () => {
    swrSet('k', 'val', 0, 0) // both windows expired immediately
    // Manually expire the entry
    const entry = swrGet<string>('k')
    if (entry) {
      entry.freshUntil = Date.now() - 2
      entry.staleUntil = Date.now() - 1
    }
    // After staleUntil passes, a fresh swrGet should return null
    // Simulate by setting with zero windows and checking after the store evicts
    swrClear()
    swrSet('k2', 'v', -1, -1)
    expect(swrGet('k2')).toBeNull()
  })

  it('swrDelete removes an entry', () => {
    const { swrDelete } = require('../_lib/swr-cache')
    swrSet('x', 1, 15_000, 60_000)
    swrDelete('x')
    expect(swrGet('x')).toBeNull()
  })
})

// ── Wallet route tests ────────────────────────────────────────────────────────

const mockWalletFindUnique = vi.hoisted(() => vi.fn())

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn().mockResolvedValue({ userId: 'privy-1' }),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: 'user-swr-1', privyId: 'privy-1' }),
    },
    wallet: {
      findUnique: mockWalletFindUnique,
    },
  },
}))

import { GET } from '../wallet/route'
import { prisma } from '@/lib/db'

const WALLET_DB = {
  id: 'w-1',
  address: 'GADDR123',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  userId: 'user-swr-1',
}

function makeReq() {
  return new Request('http://localhost/api/routes-b/wallet', {
    headers: { authorization: 'Bearer tok' },
  }) as any
}

beforeEach(() => {
  vi.clearAllMocks()
  swrClear()
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-swr-1', privyId: 'privy-1' } as any)
  mockWalletFindUnique.mockResolvedValue(WALLET_DB)
})

describe('GET /wallet — SWR caching', () => {
  it('cold miss: fetches from DB and returns wallet', async () => {
    const res = await GET(makeReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.wallet).toHaveProperty('stellarAddress', 'GADDR123')
    expect(mockWalletFindUnique).toHaveBeenCalledTimes(1)
  })

  it('fresh hit: does not call DB again within fresh window', async () => {
    // First call populates cache
    await GET(makeReq())
    // Second call should be a fresh hit
    const res2 = await GET(makeReq())
    expect(res2.status).toBe(200)
    // DB called only once (during first request)
    expect(mockWalletFindUnique).toHaveBeenCalledTimes(1)
  })

  it('stale hit: returns X-Cache: STALE header', async () => {
    // Seed the cache with an already-stale entry
    const staleEntry: SwrEntry<{ id: string; stellarAddress: string; createdAt: Date }> = {
      value: { id: 'w-1', stellarAddress: 'GADDR123', createdAt: new Date() },
      fetchedAt: Date.now() - 30_000,
      freshUntil: Date.now() - 1, // past fresh window
      staleUntil: Date.now() + 30_000, // still within stale window
    }
    swrSet('wallet:user-swr-1', staleEntry.value, -1, 60_000)
    // Manually backdate the freshUntil
    const entry = swrGet<any>('wallet:user-swr-1')!
    entry.freshUntil = Date.now() - 1

    const res = await GET(makeReq())
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Cache')).toBe('STALE')
  })

  it('beyond-stale: synchronously fetches when cache is fully expired', async () => {
    // Seed cache with an entry that is beyond the stale window
    swrSet('wallet:user-swr-1', WALLET_DB, -1, -1)
    // Beyond stale → swrGet returns null → triggers sync fetch
    const res = await GET(makeReq())
    expect(res.status).toBe(200)
    expect(mockWalletFindUnique).toHaveBeenCalledTimes(1)
  })

  it('error during fetch falls back to last known cached value', async () => {
    // First: populate the cache successfully
    await GET(makeReq())
    // Expire the fresh window but keep stale alive
    const entry = swrGet<any>('wallet:user-swr-1')!
    entry.freshUntil = Date.now() - 1

    // Now DB throws on revalidation
    mockWalletFindUnique.mockRejectedValueOnce(new Error('RPC down'))

    const res = await GET(makeReq())
    expect(res.status).toBe(200)
    // Still returns the stale cached wallet
    const body = await res.json()
    expect(body.wallet).toHaveProperty('stellarAddress', 'GADDR123')
  })

  it('returns null wallet gracefully when DB returns null', async () => {
    mockWalletFindUnique.mockResolvedValueOnce(null)
    const res = await GET(makeReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.wallet).toBeNull()
  })
})
