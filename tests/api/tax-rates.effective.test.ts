import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from '@/app/api/tax-rates/effective/route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    taxRate: { findFirst: vi.fn() },
  },
}))

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

const mockUser = { id: 'user-1', email: 'freelancer@example.com' }

function makeRequest(query: string, token = 'Bearer valid-token') {
  return new Request(`http://localhost/api/tax-rates/effective${query}`, {
    method: 'GET',
    headers: { authorization: token },
  }) as unknown as import('next/server').NextRequest
}

function rate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rate-1',
    name: 'VAT',
    jurisdiction: 'GB',
    rate: 0.2,
    effectiveFrom: new Date('2026-01-01'),
    effectiveTo: null,
    parentRateId: null,
    ...overrides,
  }
}

describe('GET /api/tax-rates/effective', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as never)
  })

  it('resolves the rate in force on the requested date', async () => {
    vi.mocked(prisma.taxRate.findFirst).mockResolvedValue(rate() as never)
    const res = await GET(makeRequest('?jurisdiction=GB&date=2026-06-01'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.id).toBe('rate-1')
    expect(json.effectiveRate).toBeCloseTo(0.2)
    expect(json.isCompound).toBe(false)
  })

  it('requires the jurisdiction parameter', async () => {
    const res = await GET(makeRequest('?date=2026-06-01'))
    expect(res.status).toBe(400)
  })

  it('rejects an invalid date', async () => {
    const res = await GET(makeRequest('?jurisdiction=GB&date=not-a-date'))
    expect(res.status).toBe(400)
  })

  it('returns 404 when no rate covers the jurisdiction and date', async () => {
    vi.mocked(prisma.taxRate.findFirst).mockResolvedValue(null as never)
    const res = await GET(makeRequest('?jurisdiction=GB&date=2020-01-01'))
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toContain('GB')
  })

  it('resolves a compound rate into a single combined percentage', async () => {
    // Leaf state tax 5% compounded on a 10% federal parent.
    vi.mocked(prisma.taxRate.findFirst)
      .mockResolvedValueOnce(
        rate({ id: 'leaf', name: 'State', rate: 0.05, parentRateId: 'root' }) as never,
      )
      .mockResolvedValueOnce(
        rate({ id: 'root', name: 'Federal', rate: 0.1, parentRateId: null }) as never,
      )
    const res = await GET(makeRequest('?jurisdiction=US-CA&date=2026-06-01'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.isCompound).toBe(true)
    expect(json.effectiveRate).toBeCloseTo(0.155)
    expect(json.components.map((c: { id: string }) => c.id)).toEqual(['root', 'leaf'])
  })

  it('defaults to now when no date is supplied', async () => {
    vi.mocked(prisma.taxRate.findFirst).mockResolvedValue(rate() as never)
    const res = await GET(makeRequest('?jurisdiction=GB'))
    expect(res.status).toBe(200)
    const call = vi.mocked(prisma.taxRate.findFirst).mock.calls[0][0]
    const where = (call as { where: { effectiveFrom: { lte: Date } } }).where
    expect(where.effectiveFrom.lte).toBeInstanceOf(Date)
  })
})
