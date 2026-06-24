import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const invoiceFindMany = vi.fn()
const loggerError = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/logger', () => ({ logger: { error: loggerError } }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    invoice: { findMany: invoiceFindMany },
  },
}))

const BASE_URL = 'http://localhost/api/routes-b/reports/late-payment'

function makeRequest(params: Record<string, string> = {}, token: string | null = 'Bearer token') {
  const url = new URL(BASE_URL)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const headers: Record<string, string> = {}
  if (token) headers.authorization = token
  return new NextRequest(url.toString(), { headers })
}

describe('GET /api/routes-b/reports/late-payment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: two separate calls, overdue first, paid-late second
    invoiceFindMany.mockResolvedValue([])
  })

  // ── Auth ────────────────────────────────────────────────────────────────

  it('returns 401 when no authorization header is provided', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-b/reports/late-payment/route')
    const res = await GET(makeRequest({}, null))
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe('Unauthorized')
  })

  it('returns 401 when the token is invalid', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-b/reports/late-payment/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
    expect(invoiceFindMany).not.toHaveBeenCalled()
  })

  // ── Validation ──────────────────────────────────────────────────────────

  it('returns 400 for an invalid year parameter', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { GET } = await import('@/app/api/routes-b/reports/late-payment/route')
    const res = await GET(makeRequest({ year: 'not-a-year' }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/Invalid year/)
  })

  it('returns 400 for a year below the minimum', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { GET } = await import('@/app/api/routes-b/reports/late-payment/route')
    const res = await GET(makeRequest({ year: '1999' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 for a year above the maximum', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { GET } = await import('@/app/api/routes-b/reports/late-payment/route')
    const res = await GET(makeRequest({ year: '2101' }))
    expect(res.status).toBe(400)
  })

  // ── Happy path — empty data ─────────────────────────────────────────────

  it('returns empty report when no invoices exist', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindMany.mockResolvedValue([])

    const { GET } = await import('@/app/api/routes-b/reports/late-payment/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.summary.overdueCount).toBe(0)
    expect(json.summary.totalOverdueAmount).toBe(0)
    expect(json.summary.paidLateCount).toBe(0)
    expect(json.summary.totalPaidLateAmount).toBe(0)
    expect(json.currentlyOverdue).toEqual([])
    expect(json.paidLate).toEqual([])
    expect(json.currency).toBe('USDC')
  })

  // ── Happy path — overdue invoices ───────────────────────────────────────

  it('returns currently overdue invoices with correct daysOverdue', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const overdueDate = new Date('2026-05-01T00:00:00Z') // in the past
    invoiceFindMany
      .mockResolvedValueOnce([
        {
          id: 'inv_1',
          invoiceNumber: 'INV-001',
          clientName: 'Acme Corp',
          clientEmail: 'client@acme.com',
          amount: '500.00',
          currency: 'USDC',
          dueDate: overdueDate,
          status: 'overdue',
          createdAt: new Date('2026-04-01T00:00:00Z'),
        },
      ])
      .mockResolvedValueOnce([]) // paid-late query returns nothing

    const { GET } = await import('@/app/api/routes-b/reports/late-payment/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.currentlyOverdue).toHaveLength(1)
    expect(json.currentlyOverdue[0].invoiceId).toBe('inv_1')
    expect(json.currentlyOverdue[0].invoiceNumber).toBe('INV-001')
    expect(json.currentlyOverdue[0].amount).toBe(500)
    expect(json.currentlyOverdue[0].daysOverdue).toBeGreaterThan(0)
    expect(json.currentlyOverdue[0].status).toBe('overdue')
    expect(json.summary.overdueCount).toBe(1)
    expect(json.summary.totalOverdueAmount).toBe(500)
  })

  // ── Happy path — paid late invoices ────────────────────────────────────

  it('returns paid-late invoices where paidAt is after dueDate', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    invoiceFindMany
      .mockResolvedValueOnce([]) // overdue query
      .mockResolvedValueOnce([
        {
          id: 'inv_2',
          invoiceNumber: 'INV-002',
          clientName: 'Beta Ltd',
          clientEmail: 'beta@example.com',
          amount: '300.00',
          currency: 'USDC',
          dueDate: new Date('2026-03-01T00:00:00Z'),
          paidAt: new Date('2026-03-15T00:00:00Z'), // 14 days late
          createdAt: new Date('2026-02-01T00:00:00Z'),
        },
      ])

    const { GET } = await import('@/app/api/routes-b/reports/late-payment/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.paidLate).toHaveLength(1)
    expect(json.paidLate[0].invoiceId).toBe('inv_2')
    expect(json.paidLate[0].invoiceNumber).toBe('INV-002')
    expect(json.paidLate[0].amount).toBe(300)
    expect(json.paidLate[0].daysLate).toBe(14)
    expect(json.summary.paidLateCount).toBe(1)
    expect(json.summary.totalPaidLateAmount).toBe(300)
  })

  it('excludes paid invoices where paidAt is on or before dueDate', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    invoiceFindMany
      .mockResolvedValueOnce([]) // overdue query
      .mockResolvedValueOnce([
        {
          id: 'inv_3',
          invoiceNumber: 'INV-003',
          clientName: 'On-time Client',
          clientEmail: 'ontime@example.com',
          amount: '200.00',
          currency: 'USDC',
          dueDate: new Date('2026-04-01T00:00:00Z'),
          paidAt: new Date('2026-03-28T00:00:00Z'), // paid before due — not late
          createdAt: new Date('2026-03-01T00:00:00Z'),
        },
      ])

    const { GET } = await import('@/app/api/routes-b/reports/late-payment/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.paidLate).toHaveLength(0)
    expect(json.summary.paidLateCount).toBe(0)
  })

  // ── Year filter ─────────────────────────────────────────────────────────

  it('applies year filter and includes year in response', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindMany.mockResolvedValue([])

    const { GET } = await import('@/app/api/routes-b/reports/late-payment/route')
    const res = await GET(makeRequest({ year: '2026' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.year).toBe(2026)

    // Verify that both findMany calls were made with date range filters
    expect(invoiceFindMany).toHaveBeenCalledTimes(2)
    expect(invoiceFindMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user_1',
          dueDate: expect.objectContaining({
            gte: new Date('2026-01-01T00:00:00Z'),
            lt: new Date('2027-01-01T00:00:00Z'),
          }),
        }),
      }),
    )
    expect(invoiceFindMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user_1',
          status: 'paid',
        }),
      }),
    )
  })

  it('omits year from response when no year param is provided', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindMany.mockResolvedValue([])

    const { GET } = await import('@/app/api/routes-b/reports/late-payment/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).not.toHaveProperty('year')
  })

  // ── Summary totals ──────────────────────────────────────────────────────

  it('aggregates amounts correctly across multiple overdue invoices', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const past = new Date('2026-01-01T00:00:00Z')
    invoiceFindMany
      .mockResolvedValueOnce([
        { id: 'a', invoiceNumber: 'A', clientName: null, clientEmail: 'a@x.com', amount: '100.00', currency: 'USDC', dueDate: past, status: 'overdue', createdAt: past },
        { id: 'b', invoiceNumber: 'B', clientName: null, clientEmail: 'b@x.com', amount: '250.50', currency: 'USDC', dueDate: past, status: 'pending', createdAt: past },
      ])
      .mockResolvedValueOnce([])

    const { GET } = await import('@/app/api/routes-b/reports/late-payment/route')
    const res = await GET(makeRequest())
    const json = await res.json()
    expect(json.summary.overdueCount).toBe(2)
    expect(json.summary.totalOverdueAmount).toBe(350.5)
  })

  // ── Error handling ──────────────────────────────────────────────────────

  it('returns 500 on unexpected database error', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockRejectedValue(new Error('DB crash'))

    const { GET } = await import('@/app/api/routes-b/reports/late-payment/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error).toBe('Failed to generate late payment report')
    expect(loggerError).toHaveBeenCalled()
  })

  it('queries overdue invoices with correct filters', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindMany.mockResolvedValue([])

    const { GET } = await import('@/app/api/routes-b/reports/late-payment/route')
    await GET(makeRequest())

    expect(invoiceFindMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user_1',
          status: { in: ['pending', 'overdue'] },
        }),
      }),
    )
  })

  it('queries paid invoices with correct status filter', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindMany.mockResolvedValue([])

    const { GET } = await import('@/app/api/routes-b/reports/late-payment/route')
    await GET(makeRequest())

    expect(invoiceFindMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user_1',
          status: 'paid',
        }),
      }),
    )
  })
})
