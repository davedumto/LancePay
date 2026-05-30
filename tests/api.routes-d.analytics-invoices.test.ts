import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const invoiceGroupBy = vi.fn()
const loggerError = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/logger', () => ({ logger: { error: loggerError } }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    invoice: { groupBy: invoiceGroupBy },
  },
}))

const URL = 'http://localhost/api/routes-d/analytics/invoices'

function makeRequest(headers: Record<string, string> = { authorization: 'Bearer token' }) {
  return new NextRequest(URL, { headers })
}

describe('GET /api/routes-d/analytics/invoices', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when the auth token is invalid', async () => {
    verifyAuthToken.mockResolvedValue(null)

    const { GET } = await import('@/app/api/routes-d/analytics/invoices/route')
    const response = await GET(makeRequest())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(userFindUnique).not.toHaveBeenCalled()
  })

  it('returns zeroed analytics when the user has no invoices', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceGroupBy.mockResolvedValue([])

    const { GET } = await import('@/app/api/routes-d/analytics/invoices/route')
    const response = await GET(makeRequest())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      invoices: {
        total: 0,
        pending: 0,
        paid: 0,
        overdue: 0,
        cancelled: 0,
        totalInvoiced: 0,
        distribution: {
          pending: { count: 0, percentage: 0 },
          paid: { count: 0, percentage: 0 },
          overdue: { count: 0, percentage: 0 },
          cancelled: { count: 0, percentage: 0 },
        },
      },
    })
  })

  it('returns invoice totals and status distribution for the authenticated user', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceGroupBy.mockResolvedValue([
      { status: 'pending', _count: { id: 1 }, _sum: { amount: '125.50' } },
      { status: 'paid', _count: { id: 3 }, _sum: { amount: '300.00' } },
      { status: 'cancelled', _count: { id: 1 }, _sum: { amount: null } },
    ])

    const { GET } = await import('@/app/api/routes-d/analytics/invoices/route')
    const response = await GET(makeRequest())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      invoices: {
        total: 5,
        pending: 1,
        paid: 3,
        overdue: 0,
        cancelled: 1,
        totalInvoiced: 425.5,
        distribution: {
          pending: { count: 1, percentage: 20 },
          paid: { count: 3, percentage: 60 },
          overdue: { count: 0, percentage: 0 },
          cancelled: { count: 1, percentage: 20 },
        },
      },
    })
    expect(invoiceGroupBy).toHaveBeenCalledWith({
      by: ['status'],
      where: { userId: 'user_1' },
      _count: { id: true },
      _sum: { amount: true },
    })
  })

  it('returns 401 when the user record is missing', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(null)

    const { GET } = await import('@/app/api/routes-d/analytics/invoices/route')
    const response = await GET(makeRequest())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
  })

  it('handles a single status occupying 100% of distribution', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceGroupBy.mockResolvedValue([
      { status: 'overdue', _count: { id: 10 }, _sum: { amount: '1000.00' } },
    ])

    const { GET } = await import('@/app/api/routes-d/analytics/invoices/route')
    const response = await GET(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.invoices.total).toBe(10)
    expect(body.invoices.overdue).toBe(10)
    expect(body.invoices.distribution.overdue).toEqual({ count: 10, percentage: 100 })
    expect(body.invoices.distribution.paid.percentage).toBe(0)
    expect(body.invoices.distribution.pending.percentage).toBe(0)
    expect(body.invoices.distribution.cancelled.percentage).toBe(0)
  })

  it('keeps distribution percentages summing to 100 within rounding tolerance', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceGroupBy.mockResolvedValue([
      { status: 'paid', _count: { id: 1 }, _sum: { amount: '100' } },
      { status: 'pending', _count: { id: 1 }, _sum: { amount: '100' } },
      { status: 'overdue', _count: { id: 1 }, _sum: { amount: '100' } },
    ])

    const { GET } = await import('@/app/api/routes-d/analytics/invoices/route')
    const response = await GET(makeRequest())
    const body = await response.json()

    const sum =
      body.invoices.distribution.paid.percentage +
      body.invoices.distribution.pending.percentage +
      body.invoices.distribution.overdue.percentage +
      body.invoices.distribution.cancelled.percentage

    expect(sum).toBeCloseTo(100, 1)
  })

  it('ignores unknown statuses returned from groupBy', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceGroupBy.mockResolvedValue([
      { status: 'paid', _count: { id: 2 }, _sum: { amount: '200' } },
      { status: 'archived', _count: { id: 5 }, _sum: { amount: '500' } },
    ])

    const { GET } = await import('@/app/api/routes-d/analytics/invoices/route')
    const response = await GET(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.invoices.total).toBe(2)
    expect(body.invoices.paid).toBe(2)
    expect(body.invoices.totalInvoiced).toBe(200)
  })

  it('returns zero percentages for an empty distribution range', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceGroupBy.mockResolvedValue([])

    const { GET } = await import('@/app/api/routes-d/analytics/invoices/route')
    const response = await GET(makeRequest())
    const body = await response.json()

    expect(body.invoices.distribution.pending.percentage).toBe(0)
    expect(body.invoices.distribution.paid.percentage).toBe(0)
    expect(body.invoices.distribution.overdue.percentage).toBe(0)
    expect(body.invoices.distribution.cancelled.percentage).toBe(0)
  })

  it('handles a single-invoice status boundary', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceGroupBy.mockResolvedValue([
      { status: 'pending', _count: { id: 1 }, _sum: { amount: '42.00' } },
    ])

    const { GET } = await import('@/app/api/routes-d/analytics/invoices/route')
    const response = await GET(makeRequest())
    const body = await response.json()

    expect(body.invoices.total).toBe(1)
    expect(body.invoices.pending).toBe(1)
    expect(body.invoices.distribution.pending).toEqual({ count: 1, percentage: 100 })
    expect(body.invoices.totalInvoiced).toBe(42)
  })

  it('returns 500 when the database query fails', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceGroupBy.mockRejectedValue(new Error('db unavailable'))

    const { GET } = await import('@/app/api/routes-d/analytics/invoices/route')
    const response = await GET(makeRequest())

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'Internal Server Error' })
    expect(loggerError).toHaveBeenCalled()
  })
})
