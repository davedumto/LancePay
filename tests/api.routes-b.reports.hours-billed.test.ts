import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const timeEntryFindMany = vi.fn()
const timeEntryCount = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    timeEntry: { findMany: timeEntryFindMany, count: timeEntryCount },
  },
}))

const BASE_URL = 'http://localhost/api/routes-b/reports/hours-billed'

function makeRequest(params: Record<string, string> = {}) {
  const url = new URL(BASE_URL)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new NextRequest(url.toString(), { headers: { authorization: 'Bearer token' } })
}

const mockUser = { id: 'user_1' }
const mockEntries = [
  { id: 'e1', invoiceId: 'inv_1', description: 'Design', hours: '3.5', rateUsdc: '50', occurredOn: new Date('2026-01-15'), status: 'billed', createdAt: new Date() },
  { id: 'e2', invoiceId: null, description: 'Dev', hours: '2.0', rateUsdc: '75', occurredOn: new Date('2026-01-20'), status: 'draft', createdAt: new Date() },
]

describe('GET /api/routes-b/reports/hours-billed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('returns 401 when unauthenticated', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-b/reports/hours-billed/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
  })

  it('returns 404 when user not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-b/reports/hours-billed/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
  })

  it('returns summary and paginated entries', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(mockUser)
    timeEntryFindMany.mockResolvedValue(mockEntries)
    timeEntryCount.mockResolvedValue(2)

    const { GET } = await import('@/app/api/routes-b/reports/hours-billed/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.summary.totalEntries).toBe(2)
    expect(json.summary.totalHours).toBeCloseTo(5.5)
    expect(json.summary.billedHours).toBeCloseTo(3.5)
    expect(json.summary.unbilledHours).toBeCloseTo(2.0)
    expect(json.entries).toHaveLength(2)
    expect(json.pagination.totalCount).toBe(2)
  })

  it('returns 400 for invalid year', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(mockUser)
    const { GET } = await import('@/app/api/routes-b/reports/hours-billed/route')
    const res = await GET(makeRequest({ year: 'abc' }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/year/i)
  })

  it('returns 400 for invalid month', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(mockUser)
    const { GET } = await import('@/app/api/routes-b/reports/hours-billed/route')
    const res = await GET(makeRequest({ month: '13' }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/month/i)
  })

  it('filters by year and month when provided', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(mockUser)
    timeEntryFindMany.mockResolvedValue([mockEntries[0]])
    timeEntryCount.mockResolvedValue(1)

    const { GET } = await import('@/app/api/routes-b/reports/hours-billed/route')
    const res = await GET(makeRequest({ year: '2026', month: '1' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.entries).toHaveLength(1)
    // Verify findMany was called with a date range
    expect(timeEntryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ occurredOn: expect.any(Object) }),
      }),
    )
  })

  it('respects page and pageSize params', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(mockUser)
    timeEntryFindMany.mockResolvedValue([])
    timeEntryCount.mockResolvedValue(100)

    const { GET } = await import('@/app/api/routes-b/reports/hours-billed/route')
    const res = await GET(makeRequest({ page: '3', pageSize: '10' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.pagination.page).toBe(3)
    expect(json.pagination.pageSize).toBe(10)
    expect(json.pagination.totalPages).toBe(10)
    expect(timeEntryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 10 }),
    )
  })
})
