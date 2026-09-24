import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET, POST } from '@/app/api/tax-rates/route'
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

function makeRequest(body: object, token = 'Bearer valid-token') {
  return new Request('http://localhost/api/tax-rates', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: token },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest
}

function makeGetRequest(query = '', token = 'Bearer valid-token') {
  return new Request(`http://localhost/api/tax-rates${query}`, {
    method: 'GET',
    headers: { authorization: token },
  }) as unknown as import('next/server').NextRequest
}

const validBody = {
  name: 'VAT',
  jurisdiction: 'GB',
  rate: 0.2,
  effectiveFrom: '2026-01-01',
}

function createdRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rate-1',
    name: 'VAT',
    description: null,
    jurisdiction: 'GB',
    rate: 0.2,
    effectiveFrom: new Date('2026-01-01'),
    effectiveTo: null,
    parentRateId: null,
    isDefault: false,
    createdAt: new Date('2026-01-01'),
    ...overrides,
  }
}

describe('POST /api/tax-rates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as never)
    vi.mocked(prisma.taxRate.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.taxRate.create).mockResolvedValue(createdRow() as never)
  })

  it('creates a tax rate on the happy path', async () => {
    const res = await POST(makeRequest(validBody))
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.jurisdiction).toBe('GB')
    expect(json.rate).toBe(0.2)
    expect(prisma.taxRate.create).toHaveBeenCalledOnce()
  })

  it('rejects a missing auth token', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await POST(makeRequest(validBody))
    expect(res.status).toBe(401)
  })

  it('rejects a negative rate', async () => {
    const res = await POST(makeRequest({ ...validBody, rate: -0.1 }))
    expect(res.status).toBe(400)
    expect(prisma.taxRate.create).not.toHaveBeenCalled()
  })

  it('rejects overlapping effective ranges for the same jurisdiction', async () => {
    vi.mocked(prisma.taxRate.findMany).mockResolvedValue([
      { effectiveFrom: new Date('2025-06-01'), effectiveTo: null },
    ] as never)
    const res = await POST(makeRequest(validBody))
    expect(res.status).toBe(409)
    expect(prisma.taxRate.create).not.toHaveBeenCalled()
  })

  it('accepts a non-overlapping adjacent range', async () => {
    vi.mocked(prisma.taxRate.findMany).mockResolvedValue([
      { effectiveFrom: new Date('2025-01-01'), effectiveTo: new Date('2026-01-01') },
    ] as never)
    const res = await POST(makeRequest(validBody))
    expect(res.status).toBe(201)
  })

  it('rejects a parent rate that does not exist', async () => {
    vi.mocked(prisma.taxRate.findFirst).mockResolvedValue(null as never)
    const res = await POST(
      makeRequest({ ...validBody, parentRateId: '11111111-1111-1111-1111-111111111111' }),
    )
    expect(res.status).toBe(400)
    expect(prisma.taxRate.create).not.toHaveBeenCalled()
  })

  it('rejects a parent rate that takes effect after this rate', async () => {
    vi.mocked(prisma.taxRate.findFirst).mockResolvedValue({
      id: 'parent-1',
      userId: 'user-1',
      effectiveFrom: new Date('2026-06-01'),
    } as never)
    const res = await POST(
      makeRequest({ ...validBody, parentRateId: '11111111-1111-1111-1111-111111111111' }),
    )
    expect(res.status).toBe(400)
  })

  it('creates a compound rate when the parent is valid and earlier', async () => {
    vi.mocked(prisma.taxRate.findFirst).mockResolvedValue({
      id: 'parent-1',
      userId: 'user-1',
      effectiveFrom: new Date('2025-01-01'),
    } as never)
    vi.mocked(prisma.taxRate.create).mockResolvedValue(
      createdRow({ parentRateId: 'parent-1' }) as never,
    )
    const res = await POST(
      makeRequest({ ...validBody, parentRateId: '11111111-1111-1111-1111-111111111111' }),
    )
    expect(res.status).toBe(201)
  })
})

describe('GET /api/tax-rates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as never)
    vi.mocked(prisma.taxRate.findMany).mockResolvedValue([createdRow()] as never)
  })

  it('lists tax rates', async () => {
    const res = await GET(makeGetRequest())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.taxRates).toHaveLength(1)
    expect(json.taxRates[0].rate).toBe(0.2)
  })

  it('filters by jurisdiction when provided', async () => {
    await GET(makeGetRequest('?jurisdiction=GB'))
    expect(prisma.taxRate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ jurisdiction: 'GB' }),
      }),
    )
  })
})
