import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from './route'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findFirst: vi.fn(), count: vi.fn(), fields: { dueDate: 'Invoice.dueDate' } },
    clientReputation: { updateMany: vi.fn(), create: vi.fn(), findUniqueOrThrow: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const FREELANCER = 'freelancer-1'
const CLIENT = '11111111-1111-4111-8111-111111111111'
const CLIENT_EMAIL = 'client@example.com'

function request(withAuth = true) {
  return new NextRequest(`http://localhost/api/clients/${CLIENT}/reputation`, {
    headers: withAuth ? { authorization: 'Bearer token' } : {},
  })
}

const context = (id = CLIENT) => ({ params: Promise.resolve({ id }) })

function mockCounts({ disputed = 0, onTime = 0, paidLate = 0, overdue = 0 }) {
  vi.mocked(prisma.invoice.count).mockImplementation((async (args: any) => {
    const where = args.where
    if (where.dispute?.isNot === null) return disputed
    if (where.status === 'pending') return overdue
    if (where.paidAt?.gt) return paidLate
    return onTime
  }) as any)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-freelancer' } as any)
  vi.mocked(prisma.user.findUnique).mockImplementation((async (args: any) => {
    if (args.where.privyId === 'privy-freelancer') return { id: FREELANCER }
    if (args.where.privyId === 'privy-stranger') return { id: 'freelancer-2' }
    if (args.where.id === CLIENT) return { id: CLIENT, email: 'Client@Example.com' }
    return null
  }) as any)
  vi.mocked(prisma.invoice.findFirst).mockImplementation((async (args: any) =>
    args.where.userId === FREELANCER ? { id: 'inv-1' } : null) as any)
  vi.mocked(prisma.clientReputation.updateMany).mockResolvedValue({ count: 1 })
  vi.mocked(prisma.clientReputation.findUniqueOrThrow).mockImplementation((async () => {
    const data = vi.mocked(prisma.clientReputation.updateMany).mock.calls.at(-1)?.[0].data as any
    return { clientEmail: CLIENT_EMAIL, ...data }
  }) as any)
  mockCounts({})
})

describe('GET /api/clients/[id]/reputation', () => {
  it('weights on-time, late and disputed invoices into one figure and caches it', async () => {
    mockCounts({ onTime: 6, paidLate: 1, overdue: 1, disputed: 1 })

    const response = await GET(request(), context())
    const body = await response.json()

    // 100 * (6 + 0.5*2 + 1) / (6 + 2 + 1 + 2) = 72.7 → 73
    expect(response.status).toBe(200)
    expect(body).toEqual({
      clientId: CLIENT,
      reputation: 73,
      hasHistory: true,
      lastCheckedAt: expect.any(String),
    })
    expect(prisma.clientReputation.updateMany).toHaveBeenCalledWith({
      where: { clientEmail: CLIENT_EMAIL, lastCheckedAt: { lt: expect.any(Date) } },
      data: { paymentScore: 73, lastCheckedAt: expect.any(Date) },
    })
  })

  it('classifies payments by paidAt against dueDate and never double-counts disputes', async () => {
    await GET(request(), context())

    const wheres = vi.mocked(prisma.invoice.count).mock.calls.map((call: any) => call[0].where)
    expect(wheres).toContainEqual({ clientEmail: CLIENT_EMAIL, dispute: { isNot: null } })
    expect(wheres).toContainEqual({
      clientEmail: CLIENT_EMAIL,
      dispute: { is: null },
      status: 'paid',
      OR: [{ dueDate: null }, { paidAt: null }, { paidAt: { lte: 'Invoice.dueDate' } }],
    })
    expect(wheres).toContainEqual({
      clientEmail: CLIENT_EMAIL,
      dispute: { is: null },
      status: 'paid',
      dueDate: { not: null },
      paidAt: { gt: 'Invoice.dueDate' },
    })
    expect(wheres).toContainEqual({
      clientEmail: CLIENT_EMAIL,
      dispute: { is: null },
      status: 'pending',
      dueDate: { lt: expect.any(Date) },
    })
  })

  it('returns the neutral default when the client has no payment history', async () => {
    const response = await GET(request(), context())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(expect.objectContaining({ reputation: 50, hasHistory: false }))
  })

  it('creates the reputation row the first time', async () => {
    mockCounts({ onTime: 3 })
    vi.mocked(prisma.clientReputation.updateMany).mockResolvedValue({ count: 0 })
    vi.mocked(prisma.clientReputation.findUniqueOrThrow).mockResolvedValue({
      clientEmail: CLIENT_EMAIL,
      paymentScore: 80,
      lastCheckedAt: new Date(),
    } as any)

    const body = await (await GET(request(), context())).json()

    expect(prisma.clientReputation.create).toHaveBeenCalledWith({
      data: { clientEmail: CLIENT_EMAIL, paymentScore: 80, lastCheckedAt: expect.any(Date) },
    })
    expect(body.reputation).toBe(80)
  })

  it('hides clients the caller has never invoiced behind the same 404 as a missing client', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-stranger' } as any)
    const stranger = await GET(request(), context())

    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-freelancer' } as any)
    const missing = await GET(request(), context('22222222-2222-4222-8222-222222222222'))

    expect(stranger.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(await stranger.json()).toEqual(await missing.json())
    expect(prisma.invoice.count).not.toHaveBeenCalled()
  })

  it('checks the relationship by linked client id or the client email', async () => {
    await GET(request(), context())

    expect(prisma.invoice.findFirst).toHaveBeenCalledWith({
      where: { userId: FREELANCER, OR: [{ clientId: CLIENT }, { clientEmail: CLIENT_EMAIL }] },
      select: { id: true },
    })
  })

  it('rejects malformed client ids and unauthenticated requests', async () => {
    expect((await GET(request(), context('not-a-uuid'))).status).toBe(400)
    expect((await GET(request(false), context())).status).toBe(401)
  })

  it('returns 500, not 404, when the database fails', async () => {
    vi.mocked(prisma.invoice.count).mockRejectedValue(new Error('database unavailable'))

    const response = await GET(request(), context())

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Failed to fetch client reputation' })
  })
})
