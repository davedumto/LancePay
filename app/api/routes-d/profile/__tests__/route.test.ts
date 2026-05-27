import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: { user: { findUnique: vi.fn(), update: vi.fn() } },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET, PATCH } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedUserUpdate = vi.mocked(prisma.user.update)

function req(method: string, auth = 'Bearer token', body?: unknown): NextRequest {
  return new NextRequest('http://localhost/api/routes-d/profile', {
    method,
    headers: {
      ...(auth ? { authorization: auth } : {}),
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const user = { id: 'user-1', privyId: 'privy-1', email: 'a@b.c', name: 'Jane', role: 'user', createdAt: new Date() }

beforeEach(() => {
  vi.resetAllMocks()
  mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
})

describe('GET /api/routes-d/profile', () => {
  it('returns 401 without a token', async () => {
    expect((await GET(req('GET', ''))).status).toBe(401)
  })

  it('returns 404 when the user is not found', async () => {
    mockedUserFind.mockResolvedValue(null as never)
    expect((await GET(req('GET'))).status).toBe(404)
  })

  it('returns the profile with wallet and bank-account count', async () => {
    mockedUserFind.mockResolvedValue({
      ...user,
      wallet: { address: 'GABC' },
      _count: { bankAccounts: 2 },
    } as never)
    const res = await GET(req('GET'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.profile.id).toBe('user-1')
    expect(json.profile.wallet).toEqual({ address: 'GABC' })
    expect(json.profile.bankAccountCount).toBe(2)
  })
})

describe('PATCH /api/routes-d/profile', () => {
  beforeEach(() => mockedUserFind.mockResolvedValue(user as never))

  it('returns 401 without a token', async () => {
    expect((await PATCH(req('PATCH', '', { name: 'X' }))).status).toBe(401)
  })

  it('rejects an empty name', async () => {
    expect((await PATCH(req('PATCH', 'Bearer token', { name: '  ' }))).status).toBe(400)
  })

  it('rejects an invalid timezone', async () => {
    expect((await PATCH(req('PATCH', 'Bearer token', { timezone: 'Not/AZone' }))).status).toBe(400)
  })

  it('updates name and timezone', async () => {
    mockedUserUpdate.mockResolvedValue({ id: 'user-1', name: 'Jane Doe', timezone: 'Africa/Lagos' } as never)
    const res = await PATCH(req('PATCH', 'Bearer token', { name: 'Jane Doe', timezone: 'Africa/Lagos' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'user-1', name: 'Jane Doe', timezone: 'Africa/Lagos' })
  })
})
