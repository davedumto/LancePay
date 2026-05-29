/**
 * Tests for issue #705 — GET /api/routes-b/invoices/overdue
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findMany: vi.fn() },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET } from '../invoices/overdue/route'

const BASE_URL = 'http://localhost/api/routes-b/invoices/overdue'
const THREE_DAYS_AGO = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)

function makeRequest(query = '', authHeader: string | null = 'Bearer token') {
  return new NextRequest(`${BASE_URL}${query}`, {
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

describe('GET /api/routes-b/invoices/overdue (#705)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as never)
  })

  it('returns 401 when authorization header is missing', async () => {
    const res = await GET(makeRequest('', null))
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' })
  })

  it('returns 401 when token is invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null as never)
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: 'Invalid token' })
  })

  it('returns 404 when user does not exist', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never)
    const res = await GET(makeRequest())
    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: 'User not found' })
  })

  it('returns paginated overdue invoices with daysOverdue', async () => {
    vi.mocked(prisma.invoice.findMany).mockResolvedValue([
      {
        id: 'inv-1',
        invoiceNumber: 'INV-001',
        clientName: 'Acme',
        amount: '100',
        currency: 'USDC',
        dueDate: THREE_DAYS_AGO,
        createdAt: THREE_DAYS_AGO,
      },
    ] as never)

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.invoices).toHaveLength(1)
    expect(body.invoices[0].daysOverdue).toBeGreaterThanOrEqual(2)
    expect(body.invoices[0].amount).toBe(100)
    expect(prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-1',
          status: 'pending',
          dueDate: expect.objectContaining({ lt: expect.any(Date), not: null }),
        }),
      }),
    )
  })

  it('returns bucketed ageing response when bucketed=true', async () => {
    vi.mocked(prisma.invoice.findMany).mockResolvedValue([] as never)

    const res = await GET(makeRequest('?bucketed=true'))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(Object.keys(body.buckets)).toEqual(['1_30', '31_60', '61_90', '90_plus'])
    expect(body.buckets['1_30']).toEqual([])
    expect(body.totals['90_plus']).toEqual({ count: 0, amount: 0 })
  })

  it('returns 500 on unexpected database error', async () => {
    vi.mocked(prisma.invoice.findMany).mockRejectedValue(new Error('DB failure') as never)
    const res = await GET(makeRequest())
    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({ error: 'Failed to list overdue invoices' })
  })
})
