import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockPrisma, mockVerifyAuthToken } = vi.hoisted(() => ({
  mockPrisma: {
    user: {
      findUnique: vi.fn(),
    },
    auditEvent: {
      findMany: vi.fn(),
    },
    auditLog: {
      findMany: vi.fn(),
    },
    invoice: {
      findMany: vi.fn(),
    },
    withdrawalTransaction: {
      findMany: vi.fn(),
    },
    structuringFlag: {
      findMany: vi.fn(),
    },
    sanctionsScreening: {
      findMany: vi.fn(),
    },
    riskAssessment: {
      findMany: vi.fn(),
    },
  },
  mockVerifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { GET } from './route'

function makeGetRequest(
  userId: string,
  query = '',
  token: string | null = 'admin-token',
  extraHeaders: Record<string, string> = {},
): NextRequest {
  const headers: Record<string, string> = { ...extraHeaders }
  if (token) headers.authorization = `Bearer ${token}`
  const url = `http://localhost/api/admin/activity-timeline/${userId}${
    query ? `?${query}` : ''
  }`
  return new NextRequest(url, { method: 'GET', headers })
}

describe('GET /api/admin/activity-timeline/[userId]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({
      userId: 'admin-1',
      role: 'super_admin',
    })
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'admin-1',
      role: 'super_admin',
    })

    mockPrisma.auditEvent.findMany.mockResolvedValue([
      {
        id: 'ae-1',
        invoiceId: 'inv-1',
        actorId: 'user-99',
        eventType: 'invoice.sent',
        metadata: { ip: '203.0.113.42' },
        createdAt: new Date('2026-05-01T10:00:00Z'),
      },
    ])
    mockPrisma.auditLog.findMany.mockResolvedValue([])
    mockPrisma.invoice.findMany.mockResolvedValue([
      {
        id: 'inv-1',
        userId: 'user-99',
        invoiceNumber: 'INV-900',
        amount: '1500.00',
        currency: 'USD',
        status: 'paid',
        clientEmail: 'buyer@acme.org',
        clientName: 'Acme Corp',
        createdAt: new Date('2026-05-01T12:00:00Z'),
      },
    ])
    mockPrisma.withdrawalTransaction.findMany.mockResolvedValue([
      {
        id: 'wd-1',
        userId: 'user-99',
        anchorId: 'moneygram',
        amount: '750.0000000',
        asset: 'USDC',
        status: 'completed',
        withdrawAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        stellarTxHash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
        createdAt: new Date('2026-05-01T14:00:00Z'),
      },
    ])
    mockPrisma.structuringFlag.findMany.mockResolvedValue([
      {
        id: 'sf-1',
        userId: 'user-99',
        status: 'escalated',
        reason: 'Rapid split payouts below reporting threshold',
        totalAmount: '9800.00',
        caseReference: 'SAR-CASE-2026-77',
        createdAt: new Date('2026-05-01T16:00:00Z'),
      },
    ])
    mockPrisma.sanctionsScreening.findMany.mockResolvedValue([])
    mockPrisma.riskAssessment.findMany.mockResolvedValue([])
  })

  it('returns 401 when unauthenticated and 403 for non-admin callers', async () => {
    const unauth = await GET(makeGetRequest('user-99', '', null), {
      params: { userId: 'user-99' },
    })
    expect(unauth.status).toBe(401)

    mockVerifyAuthToken.mockResolvedValueOnce({
      userId: 'u-1',
      role: 'freelancer',
    })
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'u-1',
      role: 'freelancer',
    })
    const forbidden = await GET(makeGetRequest('user-99'), {
      params: { userId: 'user-99' },
    })
    expect(forbidden.status).toBe(403)
  })

  it('collates events from audit_log, invoice_ledger, withdrawal_ledger, and compliance_ledger in descending chronological order', async () => {
    const res = await GET(makeGetRequest('user-99'), {
      params: { userId: 'user-99' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.timeline).toHaveLength(4)
    expect(body.timeline.map((e: { source: string }) => e.source)).toEqual([
      'compliance_ledger',
      'withdrawal_ledger',
      'invoice_ledger',
      'audit_log',
    ])
    // Tier 3 super_admin sees unmasked elevated values
    expect(body.adminTier).toBe('tier_3')
    expect(body.timeline[0].details.caseReference).toBe('SAR-CASE-2026-77')
    expect(body.timeline[1].details.withdrawAddress).toBe(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    )
    expect(body.timeline[2].details.clientEmail).toBe('buyer@acme.org')
  })

  it('masks sensitive fields according to the caller admin tier (tier_1 vs tier_2 vs tier_3)', async () => {
    // Tier 1 support_admin: masks PII, addresses, tx hashes, and compliance details
    mockVerifyAuthToken.mockResolvedValueOnce({
      userId: 'support-1',
      role: 'support_admin',
    })
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'support-1',
      role: 'support_admin',
    })

    const tier1Res = await GET(makeGetRequest('user-99'), {
      params: { userId: 'user-99' },
    })
    expect(tier1Res.status).toBe(200)
    const tier1Body = await tier1Res.json()
    expect(tier1Body.adminTier).toBe('tier_1')
    expect(tier1Body.timeline[0].details.caseReference).toBe(
      '[REDACTED_TIER_3]',
    )
    expect(tier1Body.timeline[0].details.reason).toBe('[MASKED_FOR_TIER_1]')
    expect(tier1Body.timeline[1].details.withdrawAddress).toBe('GBBD...FLA5')
    expect(tier1Body.timeline[1].details.stellarTxHash).toBe('9f86...0a08')
    expect(tier1Body.timeline[2].details.clientEmail).toBe('b***@acme.org')
    expect(tier1Body.timeline[3].details.ip).toBe('203.0.***.***')

    // Tier 2 standard ops admin: sees operational fields, masks elevated compliance caseReference
    mockVerifyAuthToken.mockResolvedValueOnce({
      userId: 'ops-1',
      role: 'admin',
    })
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'ops-1',
      role: 'admin',
    })

    const tier2Res = await GET(makeGetRequest('user-99'), {
      params: { userId: 'user-99' },
    })
    const tier2Body = await tier2Res.json()
    expect(tier2Body.adminTier).toBe('tier_2')
    expect(tier2Body.timeline[0].details.caseReference).toBe(
      '[REDACTED_TIER_3]',
    )
    expect(tier2Body.timeline[1].details.withdrawAddress).toBe(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    )
    expect(tier2Body.timeline[2].details.clientEmail).toBe('buyer@acme.org')
  })

  it('paginates by cursor across pages without overlap and rejects malformed cursors with 400', async () => {
    const page1Res = await GET(makeGetRequest('user-99', 'limit=2'), {
      params: { userId: 'user-99' },
    })
    expect(page1Res.status).toBe(200)
    const page1 = await page1Res.json()
    expect(page1.timeline).toHaveLength(2)
    expect(page1.pagination.hasMore).toBe(true)
    expect(page1.pagination.nextCursor).toBeTruthy()

    const page2Res = await GET(
      makeGetRequest(
        'user-99',
        `limit=2&cursor=${encodeURIComponent(page1.pagination.nextCursor)}`,
      ),
      { params: { userId: 'user-99' } },
    )
    expect(page2Res.status).toBe(200)
    const page2 = await page2Res.json()
    expect(page2.timeline).toHaveLength(2)
    expect(page2.pagination.hasMore).toBe(false)
    expect(page2.pagination.nextCursor).toBeNull()

    const combinedIds = [
      ...page1.timeline.map((e: { id: string }) => e.id),
      ...page2.timeline.map((e: { id: string }) => e.id),
    ]
    expect(combinedIds).toEqual([
      'compliance_ledger:sf_sf-1',
      'withdrawal_ledger:wd-1',
      'invoice_ledger:inv-1',
      'audit_log:ae-1',
    ])

    const badCursorRes = await GET(
      makeGetRequest('user-99', 'cursor=not-a-valid-cursor'),
      { params: { userId: 'user-99' } },
    )
    expect(badCursorRes.status).toBe(400)
  })
})
