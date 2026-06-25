import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const findUnique = vi.fn()
const invoiceFindMany = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique },
    invoice: { findMany: invoiceFindMany },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

const URL = 'http://localhost/api/routes-b/reports/outstanding-aging'

function req(token: string | null = 'tok') {
  const h = new Headers()
  if (token) h.set('authorization', `Bearer ${token}`)
  return new NextRequest(URL, { method: 'GET', headers: h })
}

describe('GET /api/routes-b/reports/outstanding-aging', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 with no token', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-b/reports/outstanding-aging/route')
    const res = await GET(req())
    expect(res.status).toBe(401)
  })

  it('returns 404 when user not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-b/reports/outstanding-aging/route')
    const res = await GET(req())
    expect(res.status).toBe(404)
  })

  it('returns aging buckets with no outstanding invoices', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    invoiceFindMany.mockResolvedValue([])
    const { GET } = await import('@/app/api/routes-b/reports/outstanding-aging/route')
    const res = await GET(req())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.totalOutstanding).toBe(0)
    expect(json.buckets['current']).toEqual({ count: 0, total: 0 })
  })

  it('buckets overdue invoice into correct aging band', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    const pastDue = new Date(Date.now() - 45 * 86_400_000)
    invoiceFindMany.mockResolvedValue([
      { id: 'inv-1', amount: 250, dueDate: pastDue, status: 'overdue' },
    ])
    const { GET } = await import('@/app/api/routes-b/reports/outstanding-aging/route')
    const res = await GET(req())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.buckets['31-60'].count).toBe(1)
    expect(json.totalOutstanding).toBe(250)
  })
})
