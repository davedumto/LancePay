import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    tag: { findMany: vi.fn() },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFindUnique = vi.mocked(prisma.user.findUnique)
const tagDelegate = prisma.tag as unknown as { findMany: ReturnType<typeof vi.fn> }

const URL = 'http://localhost/api/routes-d/tags'

function makeRequest(authHeader: string | null = 'Bearer token') {
  return new NextRequest(URL, {
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

describe('GET /api/routes-d/tags', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns 401 when the auth token is invalid', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await GET(makeRequest(null))
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(mockedUserFindUnique).not.toHaveBeenCalled()
  })

  it('returns 404 when the user does not exist', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    mockedUserFindUnique.mockResolvedValue(null as never)
    const res = await GET(makeRequest())
    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: 'User not found' })
    expect(tagDelegate.findMany).not.toHaveBeenCalled()
  })

  it('returns the tags with their invoice counts for the authenticated user', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    mockedUserFindUnique.mockResolvedValue({ id: 'user_1' } as never)
    tagDelegate.findMany.mockResolvedValue([
      {
        id: 't-1',
        name: 'Urgent',
        color: '#ff0000',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        _count: { invoiceTags: 3 },
      },
    ])

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.tags).toEqual([
      {
        id: 't-1',
        name: 'Urgent',
        color: '#ff0000',
        invoiceCount: 3,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ])
    expect(tagDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user_1' },
        orderBy: { name: 'asc' },
      }),
    )
  })
})
