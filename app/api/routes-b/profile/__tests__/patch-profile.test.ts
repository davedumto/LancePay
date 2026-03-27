import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { PATCH } from '../route'

// Mock dependencies
vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    error: vi.fn(),
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedFindUnique = vi.mocked(prisma.user.findUnique)
const mockedUpdate = vi.mocked(prisma.user.update)

function makeRequest(body: unknown, token?: string): NextRequest {
  const headers: Record<string, string> = {}
  if (token) headers['authorization'] = `Bearer ${token}`
  return new NextRequest('http://localhost/api/routes-b/profile', {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  })
}

const fakeUser = {
  id: 'user-uuid-123',
  privyId: 'privy-123',
  name: 'Old Name',
  email: 'jane@example.com',
}

describe('PATCH /api/routes-b/profile', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns 401 when no auth token is provided', async () => {
    const req = makeRequest({ name: 'Jane' })
    const res = await PATCH(req)
    expect(res.status).toBe(401)
  })

  it('returns 401 when auth token is invalid', async () => {
    mockedVerify.mockResolvedValue(null)
    const req = makeRequest({ name: 'Jane' }, 'bad-token')
    const res = await PATCH(req)
    expect(res.status).toBe(401)
  })

  it('returns 400 when name is missing', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-123' } as any)
    mockedFindUnique.mockResolvedValue(fakeUser as any)
    const req = makeRequest({}, 'valid-token')
    const res = await PATCH(req)
    expect(res.status).toBe(400)
  })

  it('returns 400 when name is whitespace-only', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-123' } as any)
    mockedFindUnique.mockResolvedValue(fakeUser as any)
    const req = makeRequest({ name: '   ' }, 'valid-token')
    const res = await PATCH(req)
    expect(res.status).toBe(400)
  })

  it('returns 400 when name exceeds 100 characters', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-123' } as any)
    mockedFindUnique.mockResolvedValue(fakeUser as any)
    const req = makeRequest({ name: 'A'.repeat(101) }, 'valid-token')
    const res = await PATCH(req)
    expect(res.status).toBe(400)
  })

  it('returns 400 when name is not a string', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-123' } as any)
    mockedFindUnique.mockResolvedValue(fakeUser as any)
    const req = makeRequest({ name: 123 }, 'valid-token')
    const res = await PATCH(req)
    expect(res.status).toBe(400)
  })

  it('returns 200 with updated profile on success', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-123' } as any)
    mockedFindUnique.mockResolvedValue(fakeUser as any)
    mockedUpdate.mockResolvedValue({ ...fakeUser, name: 'Jane Smith' } as any)

    const req = makeRequest({ name: 'Jane Smith' }, 'valid-token')
    const res = await PATCH(req)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({
      id: 'user-uuid-123',
      name: 'Jane Smith',
      email: 'jane@example.com',
    })
    expect(mockedUpdate).toHaveBeenCalledWith({
      where: { id: 'user-uuid-123' },
      data: { name: 'Jane Smith' },
    })
  })

  it('trims whitespace from name before saving', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-123' } as any)
    mockedFindUnique.mockResolvedValue(fakeUser as any)
    mockedUpdate.mockResolvedValue({ ...fakeUser, name: 'Jane Smith' } as any)

    const req = makeRequest({ name: '  Jane Smith  ' }, 'valid-token')
    await PATCH(req)

    expect(mockedUpdate).toHaveBeenCalledWith({
      where: { id: 'user-uuid-123' },
      data: { name: 'Jane Smith' },
    })
  })

  it('accepts a name of exactly 100 characters', async () => {
    const name100 = 'A'.repeat(100)
    mockedVerify.mockResolvedValue({ userId: 'privy-123' } as any)
    mockedFindUnique.mockResolvedValue(fakeUser as any)
    mockedUpdate.mockResolvedValue({ ...fakeUser, name: name100 } as any)

    const req = makeRequest({ name: name100 }, 'valid-token')
    const res = await PATCH(req)
    expect(res.status).toBe(200)
  })
})
