import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => {
  const referralEarning = { findFirst: vi.fn(), update: vi.fn() }
  return {
    prisma: {
      user: { findUnique: vi.fn() },
      referralEarning,
      $transaction: vi.fn(async (cb: any) => cb({ referralEarning })),
    },
  }
})
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'

const mockUser = { id: 'user-1' }
const mockClaims = { userId: 'privy-1' }

const earnedEarning = {
  id: 'earn-1',
  referrerId: 'user-1',
  referredUserId: 'user-2',
  invoiceId: 'inv-1',
  amountUsdc: '25.000000',
  platformFee: '2.500000',
  status: 'earned',
}

function makeRequest(body: unknown): [NextRequest, { params: Promise<{ id: string }> }] {
  const req = new NextRequest('http://localhost/api/referral-earnings/earn-1/clawback', {
    method: 'POST',
    headers: { authorization: 'Bearer token' },
    body: JSON.stringify(body),
  })
  return [req, { params: Promise.resolve({ id: 'earn-1' }) }]
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
  vi.mocked(prisma.referralEarning.findFirst).mockResolvedValue(earnedEarning as any)
  vi.mocked(prisma.referralEarning.update).mockResolvedValue({
    ...earnedEarning,
    status: 'clawed_back',
    clawbackReason: 'invoice inv-1 refunded',
    clawbackAt: new Date('2026-09-23T00:00:00Z'),
  } as any)
})

describe('POST /api/referral-earnings/[id]/clawback', () => {
  it('claws back an earned earning and reverses amount plus platformFee', async () => {
    const [req, ctx] = makeRequest({ reason: 'invoice inv-1 refunded', triggeringInvoiceEvent: 'refund' })
    const res = await POST(req, ctx)
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.referralEarning.status).toBe('clawed_back')
    expect(data.reversal.reversedAmountUsdc).toBe('25.000000')
    expect(data.reversal.reversedPlatformFee).toBe('2.500000')
    expect(data.reversal.totalReversedUsdc).toBe('27.500000')

    const updateData = vi.mocked(prisma.referralEarning.update).mock.calls[0][0].data
    expect(updateData.status).toBe('clawed_back')
    expect(updateData.clawbackReason).toBe('invoice inv-1 refunded')
    expect(updateData.clawbackAt).toBeDefined()
  })

  it('records an audit event referencing the triggering invoice event', async () => {
    const [req, ctx] = makeRequest({ reason: 'refunded', triggeringInvoiceEvent: 'refund' })
    await POST(req, ctx)

    expect(logAuditEvent).toHaveBeenCalledTimes(1)
    const [invoiceId, eventType, actorId, metadata] = vi.mocked(logAuditEvent).mock.calls[0]
    expect(invoiceId).toBe('inv-1')
    expect(eventType).toBe('referral_earning_clawed_back')
    expect(actorId).toBe('user-1')
    expect(metadata).toMatchObject({
      referralEarningId: 'earn-1',
      triggeringInvoiceEvent: 'refund',
      totalReversedUsdc: '27.500000',
    })
  })

  it('returns 400 when reason is missing', async () => {
    const [req, ctx] = makeRequest({ triggeringInvoiceEvent: 'refund' })
    const res = await POST(req, ctx)
    expect(res.status).toBe(400)
  })

  it('returns 404 when the earning is not owned by the caller', async () => {
    vi.mocked(prisma.referralEarning.findFirst).mockResolvedValue(null)
    const [req, ctx] = makeRequest({ reason: 'refunded' })
    const res = await POST(req, ctx)
    expect(res.status).toBe(404)
  })

  it('returns 409 when the earning is already clawed back', async () => {
    vi.mocked(prisma.referralEarning.findFirst).mockResolvedValue({ ...earnedEarning, status: 'clawed_back' } as any)
    const [req, ctx] = makeRequest({ reason: 'refunded' })
    const res = await POST(req, ctx)
    expect(res.status).toBe(409)
  })

  it('rejects clawback on a paid-out earning without an admin override', async () => {
    vi.mocked(prisma.referralEarning.findFirst).mockResolvedValue({ ...earnedEarning, status: 'paid' } as any)
    const [req, ctx] = makeRequest({ reason: 'refunded' })
    const res = await POST(req, ctx)
    const data = await res.json()

    expect(res.status).toBe(409)
    expect(data.requiresAdminOverride).toBe(true)
    expect(prisma.referralEarning.update).not.toHaveBeenCalled()
  })

  it('allows clawback on a paid-out earning with an admin override', async () => {
    vi.mocked(prisma.referralEarning.findFirst).mockResolvedValue({ ...earnedEarning, status: 'paid' } as any)
    const [req, ctx] = makeRequest({ reason: 'refunded', adminOverride: true })
    const res = await POST(req, ctx)
    expect(res.status).toBe(200)
    expect(prisma.referralEarning.update).toHaveBeenCalled()
  })

  it('returns 401 when unauthenticated', async () => {
    const req = new NextRequest('http://localhost/api/referral-earnings/earn-1/clawback', {
      method: 'POST',
      body: '{"reason":"refunded"}',
    })
    const res = await POST(req, { params: Promise.resolve({ id: 'earn-1' }) })
    expect(res.status).toBe(401)
  })

  it('returns 500 on unexpected error', async () => {
    vi.mocked(prisma.referralEarning.findFirst).mockRejectedValue(new Error('DB error'))
    const [req, ctx] = makeRequest({ reason: 'refunded' })
    const res = await POST(req, ctx)
    expect(res.status).toBe(500)
  })
})
