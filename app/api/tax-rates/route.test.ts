import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { GET, POST } from './route'
import { GET as GET_EFFECTIVE } from './effective/route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    taxRate: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  },
}))

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

const mockUser = { id: 'user-1', email: 'freelancer@example.com' }

function makePostRequest(body: object, token = 'Bearer valid-token') {
  return new Request('http://localhost/api/tax-rates', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: token },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest
}

function makeGetRequest(pathAndQuery = '/api/tax-rates', token = 'Bearer valid-token') {
  return new Request(`http://localhost${pathAndQuery}`, {
    method: 'GET',
    headers: { authorization: token },
  }) as unknown as import('next/server').NextRequest
}

const sampleRate = {
  id: 'rate-1',
  userId: 'user-1',
  name: 'California Sales Tax',
  description: 'State sales tax',
  jurisdiction: 'US-CA',
  rate: 0.0725,
  effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
  effectiveTo: null,
  parentRateId: null,
  isDefault: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
}

describe('TaxRate schema and /api/tax-rates endpoints (#1654)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as never)
    vi.mocked(prisma.taxRate.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.taxRate.create).mockResolvedValue(sampleRate as never)
  })

  it('defines jurisdiction on the TaxRate model in prisma/schema.prisma with its composite index', () => {
    const schema = readFileSync(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8')
    const taxRateBlockMatch = schema.match(/model TaxRate \{[\s\S]*?\n\}/)
    expect(taxRateBlockMatch).not.toBeNull()
    const taxRateBlock = taxRateBlockMatch![0]
    expect(taxRateBlock).toMatch(/jurisdiction\s+String\s+@db\.VarChar\(100\)/)
    expect(taxRateBlock).toContain('@@index([userId, jurisdiction, effectiveFrom])')
  })

  it('POST /api/tax-rates persists jurisdiction and returns the serialized tax rate', async () => {
    const res = await POST(
      makePostRequest({
        name: 'California Sales Tax',
        description: 'State sales tax',
        jurisdiction: 'US-CA',
        rate: 0.0725,
        effectiveFrom: '2026-01-01',
        isDefault: true,
      }),
    )
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.jurisdiction).toBe('US-CA')
    expect(json.rate).toBe(0.0725)
    expect(prisma.taxRate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-1',
          jurisdiction: 'US-CA',
          rate: 0.0725,
        }),
      }),
    )
  })

  it('GET /api/tax-rates filters and orders by jurisdiction', async () => {
    vi.mocked(prisma.taxRate.findMany).mockResolvedValue([sampleRate] as never)
    const res = await GET(makeGetRequest('/api/tax-rates?jurisdiction=US-CA'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.taxRates).toHaveLength(1)
    expect(json.taxRates[0].jurisdiction).toBe('US-CA')
    expect(prisma.taxRate.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', jurisdiction: 'US-CA' },
      orderBy: [{ jurisdiction: 'asc' }, { effectiveFrom: 'desc' }],
    })
  })

  it('GET /api/tax-rates/effective resolves effective rate by jurisdiction and date', async () => {
    vi.mocked(prisma.taxRate.findFirst).mockResolvedValue(sampleRate as never)
    const res = await GET_EFFECTIVE(
      makeGetRequest('/api/tax-rates/effective?jurisdiction=US-CA&date=2026-03-01'),
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.jurisdiction).toBe('US-CA')
    expect(json.effectiveRate).toBeCloseTo(0.0725)
    expect(prisma.taxRate.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-1',
          jurisdiction: 'US-CA',
        }),
      }),
    )
  })
})
