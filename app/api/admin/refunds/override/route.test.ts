import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockPrisma, mockVerifyAuthToken } = vi.hoisted(() => ({
  mockPrisma: {
    user: {
      findUnique: vi.fn(),
    },
    invoice: {
      findUnique: vi.fn(),
    },
    refundOverride: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
    refund: {
      update: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  },
  mockVerifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))

import { GET, POST } from './route'

function makePostRequest(body: unknown, token: string | null = 'admin-token'): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest('http://localhost/api/admin/refunds/override', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

function makeGetRequest(params = '', token: string | null = 'admin-token'): NextRequest {
  const url = `http://localhost/api/admin/refunds/override${params ? `?${params}` : ''}`
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest(url, { method: 'GET', headers })
}

describe('POST /api/admin/refunds/override', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({
      userId: 'admin-1',
      email: 'admin@lancepay.io',
      role: 'admin',
    })
    mockPrisma.refundOverride.findMany.mockResolvedValue([])
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await POST(
      makePostRequest({ invoiceId: 'inv-1', amount: 100, reason: 'Duplicate charge' }, null),
    )
    expect(res.status).toBe(401)
  })

  it('returns 403 when caller is not an admin', async () => {
    mockVerifyAuthToken.mockResolvedValueOnce({
      userId: 'user-1',
      email: 'user@lancepay.io',
      role: 'user',
    })
    mockPrisma.user.findUnique.mockResolvedValueOnce({ role: 'user' })

    const res = await POST(
      makePostRequest({ invoiceId: 'inv-1', amount: 100, reason: 'Duplicate charge' }),
    )
    expect(res.status).toBe(403)
  })

  it('returns 400 when reason is too short or amount is non-positive', async () => {
    const shortReason = await POST(
      makePostRequest({ invoiceId: 'inv-1', amount: 100, reason: 'abc' }),
    )
    expect(shortReason.status).toBe(400)

    const badAmount = await POST(
      makePostRequest({ invoiceId: 'inv-1', amount: 0, reason: 'Valid override reason' }),
    )
    expect(badAmount.status).toBe(400)
  })

  it('returns 404 when invoice does not exist', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValueOnce(null)

    const res = await POST(
      makePostRequest({
        invoiceId: 'inv-missing',
        amount: 100,
        reason: 'Customer dispute resolution',
      }),
    )
    expect(res.status).toBe(404)
  })

  it('returns 422 when override amount exceeds remaining refundable invoice balance', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValueOnce({
      id: 'inv-1',
      amount: 500,
      status: 'paid',
    })
    mockPrisma.refundOverride.findMany.mockResolvedValueOnce([
      { id: 'ro-1', amount: 400, status: 'completed' },
    ])

    const res = await POST(
      makePostRequest({
        invoiceId: 'inv-1',
        amount: 150,
        reason: 'Second partial refund attempt',
      }),
    )
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.remainingRefundable).toBe(100)
  })

  it('creates a refund override, updates linked refund, logs audit trail, and returns 201', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValueOnce({
      id: 'inv-1',
      amount: 500,
      status: 'paid',
    })
    mockPrisma.refundOverride.create.mockResolvedValueOnce({
      id: 'ro-new',
      invoiceId: 'inv-1',
      adminId: 'admin-1',
      amount: 200,
      reason: 'Executive escalation refund',
      notes: 'Approved by compliance',
      status: 'completed',
      createdAt: new Date('2026-03-01T15:00:00Z'),
    })
    mockPrisma.refund.update.mockResolvedValueOnce({ id: 'ref-1', status: 'completed' })
    mockPrisma.auditLog.create.mockResolvedValueOnce({ id: 'audit-1' })

    const res = await POST(
      makePostRequest({
        invoiceId: 'inv-1',
        refundId: 'ref-1',
        amount: 200,
        reason: 'Executive escalation refund',
        notes: 'Approved by compliance',
      }),
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.override.id).toBe('ro-new')
    expect(body.override.amount).toBe(200)
    expect(mockPrisma.refund.update).toHaveBeenCalledWith({
      where: { id: 'ref-1' },
      data: { status: 'completed' },
    })
    expect(mockPrisma.auditLog.create).toHaveBeenCalledOnce()
  })
})

describe('GET /api/admin/refunds/override', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({
      userId: 'admin-1',
      email: 'admin@lancepay.io',
      role: 'admin',
    })
  })

  it('lists refund overrides for admins', async () => {
    mockPrisma.refundOverride.findMany.mockResolvedValueOnce([
      {
        id: 'ro-1',
        invoiceId: 'inv-1',
        adminId: 'admin-1',
        amount: 125.5,
        reason: 'Dispute resolved',
        status: 'completed',
      },
    ])
    mockPrisma.refundOverride.count.mockResolvedValueOnce(1)

    const res = await GET(makeGetRequest('invoiceId=inv-1'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.overrides).toHaveLength(1)
    expect(body.overrides[0].amount).toBe(125.5)
  })
})
