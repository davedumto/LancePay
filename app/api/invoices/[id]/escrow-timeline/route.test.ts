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
    escrowEvent: {
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

function makeGetRequest(invoiceId: string, token: string | null = 'valid-token'): NextRequest {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest(
    `http://localhost/api/invoices/${invoiceId}/escrow-timeline`,
    { method: 'GET', headers },
  )
}

const SAMPLE_INVOICE = {
  id: 'inv-1',
  userId: 'owner-1',
  clientId: 'client-1',
  clientEmail: 'client@acme.com',
  escrowEnabled: true,
  escrowStatus: 'released',
  escrowContractId: 'escrow-contract-1',
  escrowReleasedAt: new Date('2026-03-03T12:00:00Z'),
  escrowDisputedAt: null,
}

describe('GET /api/invoices/[id]/escrow-timeline', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'privy-owner' })
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'owner-1',
      email: 'owner@lancepay.io',
    })
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await GET(makeGetRequest('inv-1', null), { params: { id: 'inv-1' } })
    expect(res.status).toBe(401)
  })

  it('returns 404 when invoice does not exist', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValueOnce(null)
    const res = await GET(makeGetRequest('inv-missing'), {
      params: { id: 'inv-missing' },
    })
    expect(res.status).toBe(404)
  })

  it('returns 403 when caller is neither invoice owner nor paying client', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'stranger-99',
      email: 'stranger@other.com',
    })
    mockPrisma.invoice.findUnique.mockResolvedValueOnce(SAMPLE_INVOICE)

    const res = await GET(makeGetRequest('inv-1'), { params: { id: 'inv-1' } })
    expect(res.status).toBe(403)
    expect(mockPrisma.escrowEvent.findMany).not.toHaveBeenCalled()
  })

  it('returns chronological escrow timeline with actorType and actorEmail for invoice owner and paying client', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValueOnce(SAMPLE_INVOICE)
    const mockEvents = [
      {
        id: 'ev-1',
        invoiceId: 'inv-1',
        eventType: 'escrow_created',
        actorType: 'freelancer',
        actorEmail: 'owner@lancepay.io',
        notes: 'Escrow initialized',
        metadata: { amount: 1500 },
        createdAt: new Date('2026-03-01T10:00:00Z'),
      },
      {
        id: 'ev-2',
        invoiceId: 'inv-1',
        eventType: 'escrow_funded',
        actorType: 'client',
        actorEmail: 'client@acme.com',
        notes: 'Funded via Stellar USDC',
        metadata: { txHash: '0xabc' },
        createdAt: new Date('2026-03-02T11:00:00Z'),
      },
      {
        id: 'ev-3',
        invoiceId: 'inv-1',
        eventType: 'escrow_released',
        actorType: 'client',
        actorEmail: 'client@acme.com',
        notes: 'Milestone approved',
        metadata: {},
        createdAt: new Date('2026-03-03T12:00:00Z'),
      },
    ]
    mockPrisma.escrowEvent.findMany.mockResolvedValueOnce(mockEvents)

    const res = await GET(makeGetRequest('inv-1'), { params: { id: 'inv-1' } })
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.timeline).toHaveLength(3)
    expect(body.timeline[0]).toMatchObject({
      id: 'ev-1',
      eventType: 'escrow_created',
      actorType: 'freelancer',
      actorEmail: 'owner@lancepay.io',
    })
    expect(body.timeline[1]).toMatchObject({
      id: 'ev-2',
      eventType: 'escrow_funded',
      actorType: 'client',
      actorEmail: 'client@acme.com',
    })
    expect(mockPrisma.escrowEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { invoiceId: 'inv-1' },
        orderBy: { createdAt: 'asc' },
      }),
    )
  })

  it('allows the paying client (matched by clientEmail) to view the timeline', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'external-client-user',
      email: 'client@acme.com',
    })
    mockPrisma.invoice.findUnique.mockResolvedValueOnce({
      ...SAMPLE_INVOICE,
      clientId: null,
    })
    mockPrisma.escrowEvent.findMany.mockResolvedValueOnce([])

    const res = await GET(makeGetRequest('inv-1'), { params: { id: 'inv-1' } })
    expect(res.status).toBe(200)
  })
})
