import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
  },
}))

const BASE_URL = 'http://localhost/api/routes-d/app/compatibility'

function makeRequest(params?: Record<string, string>, opts?: { auth?: string }) {
  const headers = new Headers()
  const auth = opts?.auth ?? 'Bearer token'
  if (auth) headers.set('authorization', auth)

  const url = new URL(BASE_URL)
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  }
  return new NextRequest(url.toString(), {
    method: 'GET',
    headers,
  })
}

describe('GET /api/routes-d/app/compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 if no authorization header is provided', async () => {
    const { GET } = await import('@/app/api/routes-d/app/compatibility/route')
    const res = await GET(makeRequest({ platform: 'ios', version: '2.0.0' }, { auth: '' }))
    expect(res.status).toBe(401)
  })

  it('returns 400 if platform is missing or invalid', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })

    const { GET } = await import('@/app/api/routes-d/app/compatibility/route')
    const res = await GET(makeRequest({ version: '2.0.0' }))
    expect(res.status).toBe(400)
    const res2 = await GET(makeRequest({ platform: 'windows', version: '2.0.0' }))
    expect(res2.status).toBe(400)
  })

  it('returns 400 if version is missing or invalid', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })

    const { GET } = await import('@/app/api/routes-d/app/compatibility/route')
    const res = await GET(makeRequest({ platform: 'ios' }))
    expect(res.status).toBe(400)
    const res2 = await GET(makeRequest({ platform: 'ios', version: 'invalid-semver' }))
    expect(res2.status).toBe(400)
  })

  it('returns compatible=true, updateRecommended=false when version >= recommended', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })

    const { GET } = await import('@/app/api/routes-d/app/compatibility/route')
    const res = await GET(makeRequest({ platform: 'ios', version: '2.0.0' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.compatible).toBe(true)
    expect(json.updateRequired).toBe(false)
    expect(json.updateRecommended).toBe(false)
  })

  it('returns compatible=true, updateRecommended=true when version >= min and < recommended', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })

    const { GET } = await import('@/app/api/routes-d/app/compatibility/route')
    const res = await GET(makeRequest({ platform: 'ios', version: '1.5.0' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.compatible).toBe(true)
    expect(json.updateRequired).toBe(false)
    expect(json.updateRecommended).toBe(true)
  })

  it('returns compatible=false, updateRequired=true when version < min', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })

    const { GET } = await import('@/app/api/routes-d/app/compatibility/route')
    const res = await GET(makeRequest({ platform: 'ios', version: '1.0.0' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.compatible).toBe(false)
    expect(json.updateRequired).toBe(true)
    expect(json.updateRecommended).toBe(false)
  })
})
