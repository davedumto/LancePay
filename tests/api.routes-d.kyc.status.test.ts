import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const kycApplicationFindUnique = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    kycApplication: { findUnique: kycApplicationFindUnique },
  },
}))

const BASE_URL = 'http://localhost/api/routes-d/kyc/status'

function makeRequest(opts?: { auth?: string }) {
  const headers: Record<string, string> = {}
  const auth = opts?.auth ?? 'Bearer token'
  if (auth) headers.authorization = auth
  return new NextRequest(BASE_URL, {
    method: 'GET',
    headers,
  })
}

describe('GET /api/routes-d/kyc/status', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when no auth is supplied', async () => {
    const { GET } = await import('@/app/api/routes-d/kyc/status/route')
    const res = await GET(makeRequest({ auth: '' }))
    expect(res.status).toBe(401)
  })

  it('returns 401 when token is invalid', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/kyc/status/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
  })

  it('returns 404 when user is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/kyc/status/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(404)
  })

  it('returns not_submitted status when no application exists', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    kycApplicationFindUnique.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/kyc/status/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('not_submitted')
    expect(body.application).toBe(null)
  })

  it('returns pending application status', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    kycApplicationFindUnique.mockResolvedValue({
      id: 'app_1',
      status: 'pending',
      level: 'basic',
      fullName: 'Test User',
      submittedAt: new Date('2026-06-20T00:00:00Z'),
      reviewedAt: null,
      rejectionReason: null,
      createdAt: new Date('2026-06-20T00:00:00Z'),
      updatedAt: new Date('2026-06-20T00:00:00Z'),
    })
    const { GET } = await import('@/app/api/routes-d/kyc/status/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('pending')
    expect(body.application).toMatchObject({
      id: 'app_1',
      status: 'pending',
      level: 'basic',
      fullName: 'Test User',
    })
  })

  it('returns approved application status', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    kycApplicationFindUnique.mockResolvedValue({
      id: 'app_1',
      status: 'approved',
      level: 'enhanced',
      fullName: 'Test User',
      submittedAt: new Date('2026-06-20T00:00:00Z'),
      reviewedAt: new Date('2026-06-21T00:00:00Z'),
      rejectionReason: null,
      createdAt: new Date('2026-06-20T00:00:00Z'),
      updatedAt: new Date('2026-06-21T00:00:00Z'),
    })
    const { GET } = await import('@/app/api/routes-d/kyc/status/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('approved')
    expect(body.application).toMatchObject({
      status: 'approved',
      level: 'enhanced',
      reviewedAt: expect.any(String),
    })
  })

  it('returns rejected application status with rejection reason', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    kycApplicationFindUnique.mockResolvedValue({
      id: 'app_1',
      status: 'rejected',
      level: 'basic',
      fullName: 'Test User',
      submittedAt: new Date('2026-06-20T00:00:00Z'),
      reviewedAt: new Date('2026-06-21T00:00:00Z'),
      rejectionReason: 'Document quality insufficient',
      createdAt: new Date('2026-06-20T00:00:00Z'),
      updatedAt: new Date('2026-06-21T00:00:00Z'),
    })
    const { GET } = await import('@/app/api/routes-d/kyc/status/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('rejected')
    expect(body.application).toMatchObject({
      status: 'rejected',
      rejectionReason: 'Document quality insufficient',
    })
  })

  it('selects only required fields from application', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    kycApplicationFindUnique.mockResolvedValue({
      id: 'app_1',
      status: 'pending',
      level: 'basic',
      fullName: 'Test User',
      submittedAt: new Date('2026-06-20T00:00:00Z'),
      reviewedAt: null,
      rejectionReason: null,
      createdAt: new Date('2026-06-20T00:00:00Z'),
      updatedAt: new Date('2026-06-20T00:00:00Z'),
    })
    const { GET } = await import('@/app/api/routes-d/kyc/status/route')
    await GET(makeRequest())
    expect(kycApplicationFindUnique).toHaveBeenCalledWith({
      where: { userId: 'user_1' },
      select: {
        id: true,
        status: true,
        level: true,
        fullName: true,
        submittedAt: true,
        reviewedAt: true,
        rejectionReason: true,
        createdAt: true,
        updatedAt: true,
      },
    })
  })
})
