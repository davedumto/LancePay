import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from './route'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    badgeDefinition: { findMany: vi.fn() },
    userBadge: { findMany: vi.fn(), createManyAndReturn: vi.fn() },
    transaction: { aggregate: vi.fn() },
    invoice: { count: vi.fn() },
    dispute: { count: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const SELF = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const BADGE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const BADGE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const BADGE_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const definition = (id: string, criteriaJson: unknown, name = id) => ({
  id,
  name,
  description: null,
  criteriaJson,
  imageUrl: null,
  stellarAssetCode: name.slice(0, 12),
  isActive: true,
  createdAt: new Date(),
})

function request(body?: unknown, token = 'user-token') {
  return new NextRequest('http://localhost/api/badges/award', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

// Signals: 12 paid of 12 decided invoices, $5,000 revenue, 0 disputes.
function mockSignals({ paid = 12, total = 12, openNotDue = 0, revenue = 5000, disputes = 0 } = {}) {
  vi.mocked(prisma.transaction.aggregate).mockResolvedValue({ _sum: { amount: revenue } } as any)
  vi.mocked(prisma.invoice.count).mockImplementation((async (args: any) => {
    if (args.where.status === 'paid') return paid
    if (args.where.status === 'pending') return openNotDue
    return total
  }) as any)
  vi.mocked(prisma.dispute.count).mockResolvedValue(disputes)
}

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.BADGE_SYSTEM_SECRET
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-self' } as any)
  vi.mocked(prisma.user.findUnique).mockImplementation((async (args: any) => {
    if (args.where.privyId === 'privy-self') return { id: SELF, role: 'freelancer' }
    if (args.where.privyId === 'privy-admin') return { id: OTHER, role: 'admin' }
    if (args.where.id === SELF || args.where.id === OTHER) return { id: args.where.id }
    return null
  }) as any)
  vi.mocked(prisma.userBadge.findMany).mockResolvedValue([])
  vi.mocked(prisma.userBadge.createManyAndReturn).mockImplementation((async (args: any) =>
    args.data.map((row: any, i: number) => ({ id: `ub-${i}`, stellarTxHash: null, ...row }))) as any)
  mockSignals()
})

describe('POST /api/badges/award', () => {
  it('awards an eligible badge evaluated from server-side records and returns it', async () => {
    vi.mocked(prisma.badgeDefinition.findMany).mockResolvedValue([
      definition(BADGE_A, { type: 'invoices', minInvoices: 10 }, 'VERIPRO'),
    ] as any)

    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(body.userId).toBe(SELF)
    expect(body.awarded).toEqual([
      expect.objectContaining({ badgeId: BADGE_A, name: 'VERIPRO', stellarAssetCode: 'VERIPRO' }),
    ])
    expect(prisma.badgeDefinition.findMany).toHaveBeenCalledWith({ where: { isActive: true } })
    expect(prisma.userBadge.createManyAndReturn).toHaveBeenCalledWith({
      data: [{ userId: SELF, badgeId: BADGE_A, issuedAt: expect.any(Date) }],
      skipDuplicates: true,
    })
  })

  it('skips badges the user already holds and does not report them', async () => {
    vi.mocked(prisma.badgeDefinition.findMany).mockResolvedValue([
      definition(BADGE_A, { type: 'invoices', minInvoices: 10 }),
      definition(BADGE_B, { type: 'revenue', minRevenue: 1000 }),
    ] as any)
    vi.mocked(prisma.userBadge.findMany).mockResolvedValue([{ badgeId: BADGE_A }] as any)

    const body = await (await POST(request())).json()

    expect(body.awarded.map((b: any) => b.badgeId)).toEqual([BADGE_B])
    expect(vi.mocked(prisma.userBadge.createManyAndReturn).mock.calls[0][0]!.data).toEqual([
      expect.objectContaining({ badgeId: BADGE_B }),
    ])
  })

  it('returns an empty list without writing when every eligible badge is already held', async () => {
    vi.mocked(prisma.badgeDefinition.findMany).mockResolvedValue([
      definition(BADGE_A, { type: 'invoices', minInvoices: 10 }),
    ] as any)
    vi.mocked(prisma.userBadge.findMany).mockResolvedValue([{ badgeId: BADGE_A }] as any)

    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ userId: SELF, awarded: [] })
    expect(prisma.userBadge.createManyAndReturn).not.toHaveBeenCalled()
  })

  it('awards every newly eligible badge and never an ineligible or unsupported one', async () => {
    vi.mocked(prisma.badgeDefinition.findMany).mockResolvedValue([
      definition(BADGE_A, { type: 'invoices', minInvoices: 10 }),
      definition(BADGE_B, { type: 'zero_disputes', minInvoices: 5, maxDisputes: 0 }),
      definition(BADGE_C, { type: 'revenue', minRevenue: 100000 }),
      definition('dddddddd-dddd-4ddd-8ddd-dddddddddddd', { type: 'custom', customQuery: 'SELECT 1' }),
    ] as any)

    const body = await (await POST(request())).json()

    expect(body.awarded.map((b: any) => b.badgeId)).toEqual([BADGE_A, BADGE_B])
  })

  it('returns only rows this call inserted when a concurrent call won the race', async () => {
    vi.mocked(prisma.badgeDefinition.findMany).mockResolvedValue([
      definition(BADGE_A, { type: 'invoices', minInvoices: 10 }),
      definition(BADGE_B, { type: 'revenue', minRevenue: 1000 }),
    ] as any)
    // ON CONFLICT DO NOTHING: BADGE_A was inserted by a parallel request after our read.
    vi.mocked(prisma.userBadge.createManyAndReturn).mockResolvedValue([
      { id: 'ub-b', userId: SELF, badgeId: BADGE_B, stellarTxHash: null, issuedAt: new Date() },
    ] as any)

    const body = await (await POST(request())).json()

    expect(body.awarded.map((b: any) => b.badgeId)).toEqual([BADGE_B])
  })

  it('ignores client-supplied eligibility claims', async () => {
    vi.mocked(prisma.badgeDefinition.findMany).mockResolvedValue([
      definition(BADGE_C, { type: 'revenue', minRevenue: 100000 }),
    ] as any)

    const response = await POST(request({ eligible: true, badgeIds: [BADGE_C], totalRevenue: 1e9 }))

    expect(response.status).toBe(200)
    expect((await response.json()).awarded).toEqual([])
    expect(prisma.userBadge.createManyAndReturn).not.toHaveBeenCalled()
  })

  it('forbids a non-admin from evaluating another user', async () => {
    const response = await POST(request({ userId: OTHER }))
    expect(response.status).toBe(403)
    expect(prisma.badgeDefinition.findMany).not.toHaveBeenCalled()
  })

  it('lets an admin evaluate another user', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-admin' } as any)
    vi.mocked(prisma.badgeDefinition.findMany).mockResolvedValue([])

    const response = await POST(request({ userId: SELF }))

    expect(response.status).toBe(200)
    expect((await response.json()).userId).toBe(SELF)
  })

  it('accepts the system credential only with an explicit target user', async () => {
    process.env.BADGE_SYSTEM_SECRET = 'system-secret-value'
    vi.mocked(prisma.badgeDefinition.findMany).mockResolvedValue([])

    expect((await POST(request(undefined, 'system-secret-value'))).status).toBe(400)
    expect((await POST(request({ userId: OTHER }, 'system-secret-value'))).status).toBe(200)
    expect(verifyAuthToken).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated and invalid-token requests', async () => {
    const noAuth = new NextRequest('http://localhost/api/badges/award', { method: 'POST' })
    expect((await POST(noAuth)).status).toBe(401)

    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    expect((await POST(request())).status).toBe(401)
  })

  it('validates the target user id and body', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-admin' } as any)
    expect((await POST(request({ userId: 'not-a-uuid' }))).status).toBe(400)

    const badJson = new NextRequest('http://localhost/api/badges/award', {
      method: 'POST',
      headers: { authorization: 'Bearer user-token' },
      body: '{bad',
    })
    expect((await POST(badJson)).status).toBe(400)
  })

  it('returns 404 when the target user does not exist', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-admin' } as any)
    const response = await POST(request({ userId: '33333333-3333-4333-8333-333333333333' }))
    expect(response.status).toBe(404)
  })

  it('returns 500 when the insert fails', async () => {
    vi.mocked(prisma.badgeDefinition.findMany).mockResolvedValue([
      definition(BADGE_A, { type: 'invoices', minInvoices: 10 }),
    ] as any)
    vi.mocked(prisma.userBadge.createManyAndReturn).mockRejectedValue(new Error('database unavailable'))

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Failed to award badges' })
  })
})
