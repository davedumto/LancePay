import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const kycApplicationFindMany = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    kycApplication: { findMany: kycApplicationFindMany },
  },
}))

const BASE_URL = 'http://localhost/api/routes-d/admin/compliance-queue'

function makeRequest(queryParams: Record<string, string> = {}, authHeader: string = 'Bearer token') {
  const url = new URL(BASE_URL)
  Object.entries(queryParams).forEach(([k, v]) => url.searchParams.append(k, v))
  
  const headers: Record<string, string> = {}
  if (authHeader) {
    headers.authorization = authHeader
  }
  
  return new NextRequest(url.toString(), {
    method: 'GET',
    headers,
  })
}

describe('GET /api/routes-d/admin/compliance-queue', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when authorization header is missing', async () => {
    const { GET } = await import('@/app/api/routes-d/admin/compliance-queue/route')
    const res = await GET(makeRequest({}, ''))
    expect(res.status).toBe(401)
  })

  it('returns 403 when user role is not admin', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1', role: 'freelancer' })

    const { GET } = await import('@/app/api/routes-d/admin/compliance-queue/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(403)
  })

  it('returns 404 when user profile is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(null)

    const { GET } = await import('@/app/api/routes-d/admin/compliance-queue/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(404)
  })

  it('returns 200 with kyc applications for valid admin request', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_admin' })
    userFindUnique.mockResolvedValue({ id: 'admin_id', role: 'admin' })
    kycApplicationFindMany.mockResolvedValue([
      {
        id: 'kyc_1',
        userId: 'user_1',
        status: 'pending',
        level: 'basic',
        createdAt: new Date(),
        user: {
          id: 'user_1',
          email: 'user1@example.com',
          name: 'User One',
        },
      },
    ])

    const { GET } = await import('@/app/api/routes-d/admin/compliance-queue/route')
    const res = await GET(makeRequest({ status: 'pending', limit: '10', offset: '0' }))
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.applications).toHaveLength(1)
    expect(body.applications[0].id).toBe('kyc_1')

    expect(kycApplicationFindMany).toHaveBeenCalledWith({
      where: { status: 'pending' },
      take: 10,
      skip: 0,
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    })
  })

  it('validates skip and take parameters', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_admin' })
    userFindUnique.mockResolvedValue({ id: 'admin_id', role: 'admin' })

    const { GET } = await import('@/app/api/routes-d/admin/compliance-queue/route')
    const res = await GET(makeRequest({ limit: '-5' }))
    expect(res.status).toBe(400)
  })
})
