import { describe, it, expect, beforeEach, vi } from 'vitest'
import { POST } from './route'
import { NextRequest } from 'next/server'

const refundCreate = vi.fn()
const transactionCreate = vi.fn()
const invoiceUpdate = vi.fn()
const disputeUpdate = vi.fn()
const auditCreate = vi.fn()

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    dispute: { findUnique: vi.fn(), update: disputeUpdate },
    refund: { create: refundCreate },
    transaction: { create: transactionCreate },
    invoice: { update: invoiceUpdate },
    auditEvent: { create: auditCreate },
    $transaction: vi.fn(),
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const disputeId = 'dsp-1'
const params = { id: disputeId }

function makePost(body: unknown, token = 'valid-token') {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (token) headers.set('authorization', `Bearer ${token}`)
  return new NextRequest(`http://localhost/api/routes-b/disputes/${disputeId}/resolve`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

function mockDispute(overrides: Record<string, unknown> = {}) {
  vi.mocked(prisma.dispute.findUnique).mockResolvedValue({
    id: disputeId,
    status: 'open',
    resolution: null,
    resolvedBy: null,
    resolvedAt: null,
    invoiceId: 'inv-1',
    invoice: { id: 'inv-1', userId: 'owner-1', amount: 1000, currency: 'USD' },
    ...overrides,
  } as never)
}

describe('POST /api/routes-b/disputes/[id]/resolve', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-admin' } as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'admin-1',
      role: 'admin',
      email: 'admin@example.com',
    } as never)
    refundCreate.mockResolvedValue({ id: 'ref-1' })
    // Run the interactive transaction callback against the mocked client.
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: never) =>
      (fn as (tx: typeof prisma) => unknown)(prisma),
    )
  })

  it('returns 403 for a non-privileged caller', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'u',
      role: 'freelancer',
      email: 'u@example.com',
    } as never)
    mockDispute()
    const res = await POST(makePost({ outcome: 'full-refund', favoredParty: 'client' }), { params })
    expect(res.status).toBe(403)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('applies a full refund to the ledger and marks the invoice refunded', async () => {
    mockDispute()
    const res = await POST(makePost({ outcome: 'full-refund', favoredParty: 'client' }), { params })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.outcome).toBe('full-refund')
    expect(data.amount).toBe(1000)
    expect(data.refundId).toBe('ref-1')
    expect(refundCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amount: 1000, status: 'completed' }) }),
    )
    expect(invoiceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'refunded' } }),
    )
    expect(disputeUpdate).toHaveBeenCalled()
  })

  it('rejects a partial refund amount at or above the invoice amount', async () => {
    mockDispute()
    const res = await POST(
      makePost({ outcome: 'partial-refund', favoredParty: 'client', amount: 1000 }),
      { params },
    )
    expect(res.status).toBe(400)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('applies a partial refund for a valid amount', async () => {
    mockDispute()
    const res = await POST(
      makePost({ outcome: 'partial-refund', favoredParty: 'freelancer', amount: 400 }),
      { params },
    )
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.amount).toBe(400)
    expect(invoiceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'partially_refunded' } }),
    )
  })

  it('records a no-refund outcome without touching the ledger', async () => {
    mockDispute()
    const res = await POST(makePost({ outcome: 'no-refund', favoredParty: 'freelancer' }), { params })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.amount).toBe(0)
    expect(refundCreate).not.toHaveBeenCalled()
    expect(invoiceUpdate).not.toHaveBeenCalled()
    expect(disputeUpdate).toHaveBeenCalled()
  })

  it('is idempotent and returns the existing outcome for an already-resolved dispute', async () => {
    mockDispute({
      status: 'resolved',
      resolution: JSON.stringify({ outcome: 'full-refund', favoredParty: 'client', amount: 1000 }),
      resolvedBy: 'admin-9',
      resolvedAt: new Date('2026-06-20T00:00:00.000Z'),
    })
    const res = await POST(makePost({ outcome: 'no-refund', favoredParty: 'client' }), { params })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.alreadyResolved).toBe(true)
    expect(data.resolution.outcome).toBe('full-refund')
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })
})
