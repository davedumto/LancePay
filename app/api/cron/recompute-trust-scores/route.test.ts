import { describe, it, expect, beforeEach, vi } from 'vitest'
import { TRUST_SCORE_TTL_MS } from '@/lib/trust-score'

const userTrustScoreFindMany = vi.fn()
const invoiceCount = vi.fn()
const recomputeUserTrustScore = vi.fn()

vi.mock('@/lib/db', () => ({
  prisma: {
    userTrustScore: {
      findMany: (...args: any[]) => userTrustScoreFindMany(...args),
    },
    invoice: {
      count: (...args: any[]) => invoiceCount(...args),
    },
  },
}))

vi.mock('@/lib/trust-score', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/trust-score')>()
  return {
    ...actual,
    recomputeUserTrustScore: (...args: any[]) => recomputeUserTrustScore(...args),
  }
})

import { GET } from './route'

function makeRequest(secret: string | null = 'cron_secret') {
  const headers: Record<string, string> = {}
  if (secret !== null) headers.authorization = `Bearer ${secret}`
  return new Request('http://localhost/api/cron/recompute-trust-scores', { headers })
}

const staleScore = (userId: string, lastUpdatedAt: Date) => ({
  id: `ts_${userId}`,
  userId,
  lastUpdatedAt,
  user: { id: userId, createdAt: new Date('2025-01-01') },
})

describe('GET /api/cron/recompute-trust-scores (#1893)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    process.env.CRON_SECRET = 'cron_secret'
    recomputeUserTrustScore.mockResolvedValue({})
  })

  it('rejects requests without the CRON_SECRET bearer token', async () => {
    const res = await GET(makeRequest('wrong'))
    expect(res.status).toBe(401)
    expect(userTrustScoreFindMany).not.toHaveBeenCalled()
  })

  it('selects only scores older than TRUST_SCORE_TTL_MS in bounded batches', async () => {
    userTrustScoreFindMany.mockResolvedValueOnce([])
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)

    const args = userTrustScoreFindMany.mock.calls[0][0]
    expect(args.where.lastUpdatedAt.lt.getTime()).toBeLessThanOrEqual(
      Date.now() - TRUST_SCORE_TTL_MS,
    )
    expect(args.take).toBe(100) // BATCH_SIZE default
    expect(args.orderBy).toEqual({ lastUpdatedAt: 'asc' })
  })

  it('recomputes users with invoice activity since last computation', async () => {
    const old = new Date(Date.now() - TRUST_SCORE_TTL_MS - 1000)
    userTrustScoreFindMany
      .mockResolvedValueOnce([staleScore('user_active', old)])
      .mockResolvedValueOnce([])
    invoiceCount.mockResolvedValue(2)

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(recomputeUserTrustScore).toHaveBeenCalledTimes(1)
    expect(recomputeUserTrustScore).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user_active' }),
      expect.any(Date),
    )
    expect(invoiceCount).toHaveBeenCalledWith({
      where: {
        userId: 'user_active',
        OR: [{ createdAt: { gt: old } }, { updatedAt: { gt: old } }],
      },
    })
    expect(body).toMatchObject({ recomputed: 1, skipped: 0 })
  })

  it('skips users with no invoice activity since the last computation', async () => {
    const old = new Date(Date.now() - TRUST_SCORE_TTL_MS - 1000)
    userTrustScoreFindMany
      .mockResolvedValueOnce([staleScore('user_idle', old)])
      .mockResolvedValueOnce([])
    invoiceCount.mockResolvedValue(0)

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(recomputeUserTrustScore).not.toHaveBeenCalled()
    expect(body).toMatchObject({ recomputed: 0, skipped: 1 })
  })

  it('pages through full batches until a short batch or MAX_BATCHES', async () => {
    const old = new Date(Date.now() - TRUST_SCORE_TTL_MS - 1000)
    const fullBatch = Array.from({ length: 100 }, (_, i) =>
      staleScore(`user_${i}`, old),
    )
    userTrustScoreFindMany
      .mockResolvedValueOnce(fullBatch)
      .mockResolvedValueOnce([staleScore('user_last', old)])
      .mockResolvedValueOnce([])
    invoiceCount.mockResolvedValue(1)

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(userTrustScoreFindMany).toHaveBeenCalledTimes(2)
    expect(recomputeUserTrustScore).toHaveBeenCalledTimes(101)
    expect(body.batches).toBe(2)
  })

  it('keeps processing when a single recompute fails', async () => {
    const old = new Date(Date.now() - TRUST_SCORE_TTL_MS - 1000)
    userTrustScoreFindMany
      .mockResolvedValueOnce([
        staleScore('user_bad', old),
        staleScore('user_good', old),
      ])
      .mockResolvedValueOnce([])
    invoiceCount.mockResolvedValue(1)
    recomputeUserTrustScore
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({})

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(recomputeUserTrustScore).toHaveBeenCalledTimes(2)
    expect(body.recomputed).toBe(1)
  })
})
