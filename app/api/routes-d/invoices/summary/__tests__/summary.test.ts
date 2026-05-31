import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { aggregate: vi.fn() },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFindUnique = vi.mocked(prisma.user.findUnique)
const invoiceDelegate = prisma.invoice as unknown as { aggregate: ReturnType<typeof vi.fn> }

const URL = 'http://localhost/api/routes-d/invoices/summary'

function makeRequest(authHeader: string | null = 'Bearer token') {
  return new NextRequest(URL, {
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

describe('GET /api/routes-d/invoices/summary', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns 401 when the auth token is invalid', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await GET(makeRequest(null))
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(mockedUserFindUnique).not.toHaveBeenCalled()
  })

  it('returns 404 when the user does not exist', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    mockedUserFindUnique.mockResolvedValue(null as never)
    const res = await GET(makeRequest())
    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: 'User not found' })
    expect(invoiceDelegate.aggregate).not.toHaveBeenCalled()
  })

  it('returns a six-month aggregation scoped to the authenticated user', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    mockedUserFindUnique.mockResolvedValue({ id: 'user_1' } as never)
    invoiceDelegate.aggregate.mockResolvedValue({ _count: { id: 2 }, _sum: { amount: '150.00' } })

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.summary).toHaveLength(6)
    expect(body.summary[0]).toMatchObject({
      issued: 2,
      paid: 2,
      totalIssued: 150,
      totalPaid: 150,
    })
    expect(body.summary[0].month).toMatch(/^\d{4}-\d{2}$/)
    // 2 aggregate calls (issued + paid) per month over six months
    expect(invoiceDelegate.aggregate).toHaveBeenCalledTimes(12)
    expect(invoiceDelegate.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'user_1' }) }),
    )
  })

  it('coerces null sums to zero', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    mockedUserFindUnique.mockResolvedValue({ id: 'user_1' } as never)
    invoiceDelegate.aggregate.mockResolvedValue({ _count: { id: 0 }, _sum: { amount: null } })

    const res = await GET(makeRequest())
    const body = await res.json()
    expect(body.summary[0]).toMatchObject({
      issued: 0,
      paid: 0,
      totalIssued: 0,
      totalPaid: 0,
    })
  })
})
