import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const findUnique = vi.fn()
const invoiceCount = vi.fn()
const apiUsageCount = vi.fn()
const storageAggregate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique },
    invoice: { count: invoiceCount },
    apiUsageLog: { count: apiUsageCount },
    storageUsage: { aggregate: storageAggregate },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

const URL = 'http://localhost/api/routes-d/billing/usage'

function req() {
  return new NextRequest(URL, { method: 'GET', headers: { authorization: 'Bearer tok' } })
}

describe('GET /api/routes-d/billing/usage', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 with no token', async () => {
    const { GET } = await import('@/app/api/routes-d/billing/usage/route')
    const res = await GET(new NextRequest(URL, { method: 'GET' }))
    expect(res.status).toBe(401)
  })

  it('returns usage data for free plan', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1', subscription: null })
    invoiceCount.mockResolvedValue(3)
    apiUsageCount.mockResolvedValue(150)
    storageAggregate.mockResolvedValue({ _sum: { bytes: 5_242_880 } })

    const { GET } = await import('@/app/api/routes-d/billing/usage/route')
    const res = await GET(req())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.plan).toBe('free')
    expect(json.usage.invoices.used).toBe(3)
    expect(json.usage.invoices.limit).toBe(10)
    expect(json.usage.storageMb.used).toBe(5)
  })
})
