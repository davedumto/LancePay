import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from './route'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    userTrustScore: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    invoice: { count: vi.fn() },
    dispute: { count: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const USER_ID = 'user-1'
const DAY = 24 * 60 * 60 * 1000

function request(url = 'http://localhost/api/user-trust-score', withAuth = true) {
  return new NextRequest(url, { headers: withAuth ? { authorization: 'Bearer token' } : {} })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    id: USER_ID,
    createdAt: new Date(Date.now() - 400 * DAY),
  } as any)
  // 8 of 10 decided invoices paid, 2 still open and not yet due, 1 dispute.
  vi.mocked(prisma.invoice.count).mockImplementation((async (args: any) => {
    if (args.where.status === 'paid') return 8
    if (args.where.status === 'pending') return 2
    return 12
  }) as any)
  vi.mocked(prisma.dispute.count).mockResolvedValue(1)
  vi.mocked(prisma.userTrustScore.updateMany).mockResolvedValue({ count: 1 })
  vi.mocked(prisma.userTrustScore.findUniqueOrThrow).mockImplementation((async () => {
    const data = vi.mocked(prisma.userTrustScore.updateMany).mock.calls.at(-1)?.[0].data as any
    return { userId: USER_ID, ...data }
  }) as any)
})

describe('GET /api/user-trust-score', () => {
  it('returns a fresh cached score without recomputing', async () => {
    const lastUpdatedAt = new Date(Date.now() - 5 * 60 * 1000)
    vi.mocked(prisma.userTrustScore.findUnique).mockResolvedValue({
      userId: USER_ID,
      score: 77,
      successfulInvoices: 9,
      disputeCount: 0,
      lastUpdatedAt,
    } as any)

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual(
      expect.objectContaining({ score: 77, successfulInvoices: 9, disputeCount: 0, lastUpdatedAt: lastUpdatedAt.toISOString() }),
    )
    expect(prisma.invoice.count).not.toHaveBeenCalled()
    expect(prisma.userTrustScore.updateMany).not.toHaveBeenCalled()
  })

  it('recomputes and persists a stale score from invoices, disputes and account age', async () => {
    vi.mocked(prisma.userTrustScore.findUnique).mockResolvedValue({
      userId: USER_ID,
      score: 10,
      successfulInvoices: 0,
      disputeCount: 9,
      lastUpdatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    } as any)

    const body = await (await GET(request())).json()

    // completion 50*(8+1)/(10+2)=37.5, disputes 30-6=24, longevity 20 → 81.5 → 82
    expect(body.score).toBe(82)
    expect(body.successfulInvoices).toBe(8)
    expect(body.disputeCount).toBe(1)
    expect(prisma.userTrustScore.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, lastUpdatedAt: { lt: expect.any(Date) } },
      data: { score: 82, disputeCount: 1, successfulInvoices: 8, lastUpdatedAt: expect.any(Date) },
    })
  })

  it('computes and creates the row the first time', async () => {
    vi.mocked(prisma.userTrustScore.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.userTrustScore.updateMany).mockResolvedValue({ count: 0 })
    vi.mocked(prisma.userTrustScore.findUniqueOrThrow).mockImplementation((async () => {
      const data = vi.mocked(prisma.userTrustScore.create).mock.calls[0][0].data as any
      return data
    }) as any)

    const response = await GET(request())

    expect(response.status).toBe(200)
    expect(prisma.userTrustScore.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: USER_ID, score: 82 }),
    })
  })

  it('keeps the concurrently written row when a create races (P2002)', async () => {
    const newer = { userId: USER_ID, score: 90, successfulInvoices: 11, disputeCount: 0, lastUpdatedAt: new Date() }
    vi.mocked(prisma.userTrustScore.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.userTrustScore.updateMany).mockResolvedValue({ count: 0 })
    vi.mocked(prisma.userTrustScore.create).mockRejectedValue(Object.assign(new Error('Unique'), { code: 'P2002' }))
    vi.mocked(prisma.userTrustScore.findUniqueOrThrow).mockResolvedValue(newer as any)

    const response = await GET(request())

    expect(response.status).toBe(200)
    expect((await response.json()).score).toBe(90)
  })

  it('always scores the caller, ignoring any user selector in the query', async () => {
    vi.mocked(prisma.userTrustScore.findUnique).mockResolvedValue(null)

    await GET(request('http://localhost/api/user-trust-score?userId=someone-else'))

    expect(prisma.userTrustScore.findUnique).toHaveBeenCalledWith({ where: { userId: USER_ID } })
    expect(prisma.invoice.count).toHaveBeenCalledWith({ where: { userId: USER_ID } })
  })

  it('rejects unauthenticated requests', async () => {
    expect((await GET(request(undefined, false))).status).toBe(401)
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    expect((await GET(request())).status).toBe(401)
  })

  it('returns 404 when the caller has no user record', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    expect((await GET(request())).status).toBe(404)
  })

  it('returns 500 when the database fails', async () => {
    vi.mocked(prisma.userTrustScore.findUnique).mockRejectedValue(new Error('database unavailable'))
    const response = await GET(request())
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Failed to fetch trust score' })
  })
})
