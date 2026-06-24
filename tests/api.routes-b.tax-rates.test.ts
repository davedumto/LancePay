import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const taxRateFindMany = vi.fn()
const taxRateCreate = vi.fn()
const taxRateUpdateMany = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    taxRate: {
      findMany: taxRateFindMany,
      create: taxRateCreate,
      updateMany: taxRateUpdateMany,
    },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

const URL = 'http://localhost/api/routes-b/tax-rates'

function getReq() {
  return new NextRequest(URL, { headers: { authorization: 'Bearer tok' } })
}
function postReq(body: unknown) {
  return new NextRequest(URL, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', authorization: 'Bearer tok' },
  })
}

describe('GET /api/routes-b/tax-rates', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when unauthenticated', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-b/tax-rates/route')
    const res = await GET(new NextRequest(URL))
    expect(res.status).toBe(401)
  })

  it('returns an array of tax rates', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    taxRateFindMany.mockResolvedValue([
      { id: 'tr1', name: 'VAT', rate: '0.15', isDefault: true },
    ])
    const { GET } = await import('@/app/api/routes-b/tax-rates/route')
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.taxRates).toHaveLength(1)
    expect(body.taxRates[0].name).toBe('VAT')
  })
})

describe('POST /api/routes-b/tax-rates', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 400 when name is missing', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { POST } = await import('@/app/api/routes-b/tax-rates/route')
    const res = await POST(postReq({ rate: 10 }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when rate is out of range', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { POST } = await import('@/app/api/routes-b/tax-rates/route')
    const res = await POST(postReq({ name: 'Bad', rate: 150 }))
    expect(res.status).toBe(400)
  })

  it('creates a tax rate and returns 201', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    taxRateCreate.mockResolvedValue({
      id: 'tr2',
      name: 'GST',
      description: null,
      rate: '0.10',
      isDefault: false,
      createdAt: new Date('2026-06-23'),
      updatedAt: new Date('2026-06-23'),
    })
    const { POST } = await import('@/app/api/routes-b/tax-rates/route')
    const res = await POST(postReq({ name: 'GST', rate: 10, isDefault: false }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.taxRate.id).toBe('tr2')
    expect(taxRateUpdateMany).not.toHaveBeenCalled()
  })

  it('clears existing default before setting a new one', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    taxRateUpdateMany.mockResolvedValue({ count: 1 })
    taxRateCreate.mockResolvedValue({
      id: 'tr3',
      name: 'Custom',
      description: null,
      rate: '0.05',
      isDefault: true,
      createdAt: new Date('2026-06-23'),
      updatedAt: new Date('2026-06-23'),
    })
    const { POST } = await import('@/app/api/routes-b/tax-rates/route')
    const res = await POST(postReq({ name: 'Custom', rate: 5, isDefault: true }))
    expect(res.status).toBe(201)
    expect(taxRateUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { isDefault: false } }),
    )
  })
})
