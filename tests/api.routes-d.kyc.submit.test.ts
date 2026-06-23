import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const kycApplicationFindUnique = vi.fn()
const kycApplicationUpsert = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    kycApplication: { findUnique: kycApplicationFindUnique, upsert: kycApplicationUpsert },
  },
}))

const BASE_URL = 'http://localhost/api/routes-d/kyc/submit'

function makeRequest(body?: unknown, opts?: { auth?: string }) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const auth = opts?.auth ?? 'Bearer token'
  if (auth) headers.authorization = auth
  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

const validBody = {
  fullName: 'Glory Eneje',
  countryCode: 'NG',
  dateOfBirth: '1995-04-12',
  level: 'basic',
}

describe('POST /api/routes-d/kyc/submit', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when no auth is supplied', async () => {
    const { POST } = await import('@/app/api/routes-d/kyc/submit/route')
    const res = await POST(makeRequest(validBody, { auth: '' }))
    expect(res.status).toBe(401)
  })

  it('returns 400 for missing fullName', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { POST } = await import('@/app/api/routes-d/kyc/submit/route')
    const res = await POST(makeRequest({ ...validBody, fullName: '' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 for an invalid 3-letter country code', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { POST } = await import('@/app/api/routes-d/kyc/submit/route')
    const res = await POST(makeRequest({ ...validBody, countryCode: 'NGA' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 for a future dateOfBirth', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const future = new Date(Date.now() + 86_400_000).toISOString()
    const { POST } = await import('@/app/api/routes-d/kyc/submit/route')
    const res = await POST(makeRequest({ ...validBody, dateOfBirth: future }))
    expect(res.status).toBe(400)
  })

  it('returns 409 when an existing application is pending', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    kycApplicationFindUnique.mockResolvedValue({ status: 'pending' })
    const { POST } = await import('@/app/api/routes-d/kyc/submit/route')
    const res = await POST(makeRequest(validBody))
    expect(res.status).toBe(409)
    expect(kycApplicationUpsert).not.toHaveBeenCalled()
  })

  it('returns 201 and upserts on a valid submission', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    kycApplicationFindUnique.mockResolvedValue(null)
    kycApplicationUpsert.mockResolvedValue({ id: 'app_1', status: 'pending' })
    const { POST } = await import('@/app/api/routes-d/kyc/submit/route')
    const res = await POST(makeRequest(validBody))
    expect(res.status).toBe(201)
    expect(kycApplicationUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user_1' },
        create: expect.objectContaining({ status: 'pending', fullName: 'Glory Eneje', countryCode: 'NG' }),
      }),
    )
  })

  it('allows resubmission after a rejection (status=rejected)', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    kycApplicationFindUnique.mockResolvedValue({ status: 'rejected' })
    kycApplicationUpsert.mockResolvedValue({ id: 'app_1', status: 'pending' })
    const { POST } = await import('@/app/api/routes-d/kyc/submit/route')
    const res = await POST(makeRequest(validBody))
    expect(res.status).toBe(201)
  })
})
