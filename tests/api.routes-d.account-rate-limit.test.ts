import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const getClientIp = vi.fn()
const peekRateLimitStatus = vi.fn()
const loggerError = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/logger', () => ({ logger: { error: loggerError } }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
  },
}))
vi.mock('@/lib/rate-limit', () => ({
  getClientIp,
  peekRateLimitStatus,
}))

const BASE_URL = 'http://localhost/api/routes-d/account/rate-limit'

function makeRequest(opts?: { auth?: string | null; ip?: string }) {
  const authValue = opts?.auth === undefined ? 'Bearer token' : opts.auth
  const headers: Record<string, string> = {}
  if (authValue) headers.authorization = authValue
  if (opts?.ip) headers['x-forwarded-for'] = opts.ip
  return new NextRequest(BASE_URL, { headers })
}

const SAMPLE_POLICIES = [
  { policyId: 'api-pay', limit: 60, remaining: 59, resetAt: Date.now() + 50_000, allowed: true },
  { policyId: 'api-auth', limit: 30, remaining: 30, resetAt: 0, allowed: true },
]

describe('GET /api/routes-d/account/rate-limit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getClientIp.mockReturnValue('203.0.113.1')
    peekRateLimitStatus.mockReturnValue(SAMPLE_POLICIES)
  })

  // ── Auth ────────────────────────────────────────────────────────────────

  it('returns 401 when no authorization header is provided', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/account/rate-limit/route')
    const res = await GET(makeRequest({ auth: null }))
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe('Unauthorized')
    expect(peekRateLimitStatus).not.toHaveBeenCalled()
  })

  it('returns 401 when the token is invalid', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/account/rate-limit/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
    expect(peekRateLimitStatus).not.toHaveBeenCalled()
  })

  // ── Happy path ──────────────────────────────────────────────────────────

  it('returns 200 with ip and policies array', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { GET } = await import('@/app/api/routes-d/account/rate-limit/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ip).toBe('203.0.113.1')
    expect(Array.isArray(json.policies)).toBe(true)
    expect(json.policies).toHaveLength(2)
  })

  it('includes required fields on each policy entry', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { GET } = await import('@/app/api/routes-d/account/rate-limit/route')
    const res = await GET(makeRequest())
    const json = await res.json()
    for (const policy of json.policies) {
      expect(policy).toHaveProperty('policyId')
      expect(policy).toHaveProperty('limit')
      expect(policy).toHaveProperty('remaining')
      expect(policy).toHaveProperty('resetAt')
      expect(policy).toHaveProperty('allowed')
    }
  })

  it('serialises resetAt as an ISO string when the window is active', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { GET } = await import('@/app/api/routes-d/account/rate-limit/route')
    const res = await GET(makeRequest())
    const json = await res.json()
    const apiPay = json.policies.find((p: { policyId: string }) => p.policyId === 'api-pay')
    expect(apiPay.resetAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('serialises resetAt as null when no window is active (resetAt = 0)', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { GET } = await import('@/app/api/routes-d/account/rate-limit/route')
    const res = await GET(makeRequest())
    const json = await res.json()
    const apiAuth = json.policies.find((p: { policyId: string }) => p.policyId === 'api-auth')
    expect(apiAuth.resetAt).toBeNull()
  })

  it('calls getClientIp and peekRateLimitStatus with the correct IP', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    getClientIp.mockReturnValue('10.0.0.1')
    peekRateLimitStatus.mockReturnValue([])
    const req = makeRequest({ ip: '10.0.0.1' })
    const { GET } = await import('@/app/api/routes-d/account/rate-limit/route')
    await GET(req)
    expect(getClientIp).toHaveBeenCalledWith(req)
    expect(peekRateLimitStatus).toHaveBeenCalledWith('10.0.0.1')
  })

  it('returns an empty policies array when no policies exist for the IP', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    peekRateLimitStatus.mockReturnValue([])
    const { GET } = await import('@/app/api/routes-d/account/rate-limit/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.policies).toEqual([])
  })

  it('reflects the allowed:false state when limit is exhausted', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    peekRateLimitStatus.mockReturnValue([
      { policyId: 'api-pay', limit: 60, remaining: 0, resetAt: Date.now() + 30_000, allowed: false },
    ])
    const { GET } = await import('@/app/api/routes-d/account/rate-limit/route')
    const res = await GET(makeRequest())
    const json = await res.json()
    expect(json.policies[0].allowed).toBe(false)
    expect(json.policies[0].remaining).toBe(0)
  })

  // ── Error handling ──────────────────────────────────────────────────────

  it('returns 500 on an unexpected error', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockRejectedValue(new Error('DB crash'))
    const { GET } = await import('@/app/api/routes-d/account/rate-limit/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error).toBe('Failed to fetch rate-limit status')
    expect(loggerError).toHaveBeenCalled()
  })
})
