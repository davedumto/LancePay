import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET, POST } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findFirst: vi.fn() },
    paymentAdvance: { count: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))
vi.mock('@/lib/exchange-rate', () => ({ getUsdToNgnRate: vi.fn() }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { getUsdToNgnRate } from '@/lib/exchange-rate'

const mockUser = { id: 'user-1' }
const mockClaims = { userId: 'privy-1' }

function makeGet(url: string): NextRequest {
  return new NextRequest(url, { headers: { authorization: 'Bearer token' } })
}

function makePost(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/payment-advances', {
    method: 'POST',
    headers: { authorization: 'Bearer token' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
  vi.mocked(prisma.invoice.findFirst).mockResolvedValue({ id: 'inv-1', status: 'pending' } as any)
  vi.mocked(prisma.paymentAdvance.findFirst).mockResolvedValue(null)
  vi.mocked(prisma.paymentAdvance.count).mockResolvedValue(0)
  vi.mocked(prisma.paymentAdvance.findMany).mockResolvedValue([])
  vi.mocked(prisma.paymentAdvance.create).mockResolvedValue({ id: 'adv-1', status: 'pending' } as any)
  vi.mocked(getUsdToNgnRate).mockResolvedValue({ rate: 1600, lastUpdated: 'now', fromCache: false } as any)
})

describe('GET /api/payment-advances', () => {
  it('lists advances restricted to the caller', async () => {
    const res = await GET(makeGet('http://localhost/api/payment-advances'))
    const data = await res.json()

    expect(res.status).toBe(200)
    const where = vi.mocked(prisma.paymentAdvance.findMany).mock.calls[0][0]!.where
    expect(where).toEqual({ userId: 'user-1' })
    expect(data.pagination).toEqual({ page: 1, pageSize: 25, totalRows: 0, totalPages: 1 })
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await GET(new NextRequest('http://localhost/api/payment-advances'))
    expect(res.status).toBe(401)
  })
})

describe('POST /api/payment-advances', () => {
  it('creates an advance with computed fee, repayment and NGN amounts', async () => {
    const res = await POST(makePost({ invoiceId: 'inv-1', requestedAmountUSDC: 100, feePercentage: 2 }))
    const data = await res.json()

    expect(res.status).toBe(201)
    const created = vi.mocked(prisma.paymentAdvance.create).mock.calls[0][0].data
    expect(created.feeAmountUSDC).toBe('2.00')
    expect(created.totalRepaymentUSDC).toBe('102.00')
    expect(created.advancedAmountUSDC).toBe('100.00')
    expect(created.advancedAmountNGN).toBe('160000.00')
    expect(created.exchangeRate).toBe('1600.0000')
    expect(data.paymentAdvance.id).toBe('adv-1')
  })

  it('defaults feePercentage to 2 when omitted', async () => {
    await POST(makePost({ invoiceId: 'inv-1', requestedAmountUSDC: 100 }))
    const created = vi.mocked(prisma.paymentAdvance.create).mock.calls[0][0].data
    expect(created.feePercentage).toBe('2.00')
    expect(created.feeAmountUSDC).toBe('2.00')
  })

  it('returns 400 when invoiceId is missing', async () => {
    const res = await POST(makePost({ requestedAmountUSDC: 100 }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when requestedAmountUSDC is not positive', async () => {
    const res = await POST(makePost({ invoiceId: 'inv-1', requestedAmountUSDC: 0 }))
    expect(res.status).toBe(400)
  })

  it('returns 404 when the invoice is not owned by the caller', async () => {
    vi.mocked(prisma.invoice.findFirst).mockResolvedValue(null)
    const res = await POST(makePost({ invoiceId: 'inv-1', requestedAmountUSDC: 100 }))
    expect(res.status).toBe(404)
  })

  it('returns 409 when the invoice is already paid', async () => {
    vi.mocked(prisma.invoice.findFirst).mockResolvedValue({ id: 'inv-1', status: 'paid' } as any)
    const res = await POST(makePost({ invoiceId: 'inv-1', requestedAmountUSDC: 100 }))
    expect(res.status).toBe(409)
  })

  it('returns 409 when the invoice is void', async () => {
    vi.mocked(prisma.invoice.findFirst).mockResolvedValue({ id: 'inv-1', status: 'void' } as any)
    const res = await POST(makePost({ invoiceId: 'inv-1', requestedAmountUSDC: 100 }))
    expect(res.status).toBe(409)
  })

  it('returns 409 when an active advance already exists', async () => {
    vi.mocked(prisma.paymentAdvance.findFirst).mockResolvedValue({ id: 'adv-existing', status: 'disbursed' } as any)
    const res = await POST(makePost({ invoiceId: 'inv-1', requestedAmountUSDC: 100 }))
    const data = await res.json()
    expect(res.status).toBe(409)
    expect(data.advanceId).toBe('adv-existing')
  })

  it('returns 401 when unauthenticated', async () => {
    const req = new NextRequest('http://localhost/api/payment-advances', {
      method: 'POST',
      body: '{"invoiceId":"inv-1","requestedAmountUSDC":100}',
    })
    const res = await POST(req)
    expect(res.status).toBe(401)
  })

  it('returns 500 on unexpected error', async () => {
    vi.mocked(prisma.paymentAdvance.create).mockRejectedValue(new Error('DB error'))
    const res = await POST(makePost({ invoiceId: 'inv-1', requestedAmountUSDC: 100 }))
    expect(res.status).toBe(500)
  })
})
