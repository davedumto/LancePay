import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const contactFindFirst = vi.fn()
const invoiceFindMany = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    contact: { findFirst: contactFindFirst },
    invoice: { findMany: invoiceFindMany },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

function getReq(id: string) {
  return new NextRequest(`http://localhost/api/routes-b/clients/${id}/profitability`, {
    headers: { authorization: 'Bearer tok' },
  })
}

describe('GET /api/routes-b/clients/[id]/profitability', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when unauthenticated', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-b/clients/[id]/profitability/route')
    const res = await GET(
      new NextRequest('http://localhost/api/routes-b/clients/c1/profitability'),
      { params: Promise.resolve({ id: 'c1' }) },
    )
    expect(res.status).toBe(401)
  })

  it('returns 404 when client contact does not exist', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    contactFindFirst.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-b/clients/[id]/profitability/route')
    const res = await GET(getReq('gone'), { params: Promise.resolve({ id: 'gone' }) })
    expect(res.status).toBe(404)
  })

  it('returns zero report when client has no paid invoices', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    contactFindFirst.mockResolvedValue({ id: 'c1', name: 'ACME', email: 'acme@test.com' })
    invoiceFindMany.mockResolvedValue([])
    const { GET } = await import('@/app/api/routes-b/clients/[id]/profitability/route')
    const res = await GET(getReq('c1'), { params: Promise.resolve({ id: 'c1' }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.report.invoiceCount).toBe(0)
    expect(body.report.totalRevenue).toBe('0.00')
    expect(body.report.avgInvoiceValue).toBe('0.00')
  })

  it('calculates totals across paid invoices correctly', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    contactFindFirst.mockResolvedValue({ id: 'c1', name: 'ACME', email: 'acme@test.com' })
    invoiceFindMany.mockResolvedValue([
      { id: 'inv1', amount: { toString: () => '100.00' }, currency: 'USD', paidAt: new Date() },
      { id: 'inv2', amount: { toString: () => '200.00' }, currency: 'USD', paidAt: new Date() },
    ])
    const { GET } = await import('@/app/api/routes-b/clients/[id]/profitability/route')
    const res = await GET(getReq('c1'), { params: Promise.resolve({ id: 'c1' }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.report.invoiceCount).toBe(2)
    expect(body.report.totalRevenue).toBe('300.00')
    expect(body.report.avgInvoiceValue).toBe('150.00')
    expect(body.report.currency).toBe('USD')
    expect(body.clientName).toBe('ACME')
  })
})
