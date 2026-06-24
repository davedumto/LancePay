import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)

function makeRequest(auth: string | null = 'Bearer token'): NextRequest {
  return new NextRequest('http://localhost/api/routes-d/roles', {
    headers: auth ? { authorization: auth } : {},
  })
}

describe('GET /api/routes-d/roles', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns 401 when no auth header is provided', async () => {
    const res = await GET(makeRequest(null))
    expect(res.status).toBe(401)
  })

  it('returns 401 when token is invalid', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
  })

  it('returns 404 when user is not found', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFind.mockResolvedValue(null as never)
    const res = await GET(makeRequest())
    expect(res.status).toBe(404)
  })

  it('returns 200 with roles list for authenticated user', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFind.mockResolvedValue({ id: 'user-1' } as never)

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)

    const json = await res.json()
    expect(json.roles).toBeInstanceOf(Array)
    expect(json.roles.length).toBeGreaterThan(0)
    expect(json.roles[0]).toHaveProperty('id')
    expect(json.roles[0]).toHaveProperty('label')
    expect(json.roles[0]).toHaveProperty('description')
  })

  it('includes freelancer, admin, and client roles', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFind.mockResolvedValue({ id: 'user-1' } as never)

    const res = await GET(makeRequest())
    const json = await res.json()
    const roleIds = json.roles.map((r: { id: string }) => r.id)

    expect(roleIds).toContain('freelancer')
    expect(roleIds).toContain('admin')
    expect(roleIds).toContain('client')
  })

  it('returns 500 on unexpected error', async () => {
    mockedVerify.mockRejectedValue(new Error('DB error') as never)
    const res = await GET(makeRequest())
    expect(res.status).toBe(500)
  })
})
