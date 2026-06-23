import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const kycFindUnique = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    kycApplication: { findUnique: kycFindUnique },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

const URL = 'http://localhost/api/routes-d/withdrawals/limits'

function getReq() {
  return new NextRequest(URL, { headers: { authorization: 'Bearer tok' } })
}

describe('GET /api/routes-d/withdrawals/limits', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when unauthenticated', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/withdrawals/limits/route')
    const res = await GET(new NextRequest(URL))
    expect(res.status).toBe(401)
  })

  it('returns "none" tier limits when user has no KYC', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    kycFindUnique.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/withdrawals/limits/route')
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.kycLevel).toBe('none')
    expect(body.limits.perTransaction.amountUsdc).toBe(100)
    expect(body.supportedAnchors).toHaveLength(0)
  })

  it('returns "none" tier when KYC exists but is not approved', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    kycFindUnique.mockResolvedValue({ level: 'basic', status: 'pending' })
    const { GET } = await import('@/app/api/routes-d/withdrawals/limits/route')
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.kycLevel).toBe('none')
  })

  it('returns "basic" tier limits when KYC is approved at basic level', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    kycFindUnique.mockResolvedValue({ level: 'basic', status: 'approved' })
    const { GET } = await import('@/app/api/routes-d/withdrawals/limits/route')
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.kycLevel).toBe('basic')
    expect(body.limits.perTransaction.amountUsdc).toBe(1_000)
    expect(body.limits.monthly.amountUsdc).toBe(10_000)
    expect(body.supportedAnchors).toContain('moneygram')
  })

  it('returns "enhanced" tier limits when KYC is approved at enhanced level', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    kycFindUnique.mockResolvedValue({ level: 'enhanced', status: 'approved' })
    const { GET } = await import('@/app/api/routes-d/withdrawals/limits/route')
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.kycLevel).toBe('enhanced')
    expect(body.limits.perTransaction.amountUsdc).toBe(10_000)
    expect(body.limits.monthly.amountUsdc).toBe(100_000)
  })

  it('includes currency field in response', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    kycFindUnique.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/withdrawals/limits/route')
    const res = await GET(getReq())
    const body = await res.json()
    expect(body.currency).toBe('USDC')
  })
})
