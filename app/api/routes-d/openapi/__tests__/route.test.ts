import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  verifyAuthToken: vi.fn(),
  userFindUnique: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: mocks.verifyAuthToken,
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: mocks.userFindUnique,
    },
  },
}))

import { GET } from '../route'

const BASE_URL = 'http://localhost/api/routes-d/openapi'

function makeRequest(token: string | null = 'valid-token') {
  const headers = new Headers()
  if (token) {
    headers.set('authorization', `Bearer ${token}`)
  }
  return new NextRequest(BASE_URL, {
    method: 'GET',
    headers,
  })
}

describe('GET /api/routes-d/openapi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 if no authorization header is provided', async () => {
    const res = await GET(makeRequest(null))
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe('Unauthorized')
  })

  it('returns 401 if token is invalid', async () => {
    mocks.verifyAuthToken.mockResolvedValue(null)
    const res = await GET(makeRequest('invalid-token'))
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe('Invalid token')
  })

  it('returns 401 if user is not found', async () => {
    mocks.verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    mocks.userFindUnique.mockResolvedValue(null)
    const res = await GET(makeRequest('valid-token'))
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe('User not found')
  })

  it('returns 200 and the OpenAPI specification when successful', async () => {
    mocks.verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    mocks.userFindUnique.mockResolvedValue({ id: 'user-1' })
    const res = await GET(makeRequest('valid-token'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.openapi).toBe('3.1.0')
    expect(json.info.title).toBe('LancePay Routes-D API')
    expect(json.paths['/openapi']).toBeDefined()
  })
})
