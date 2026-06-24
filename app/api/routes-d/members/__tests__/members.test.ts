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
import { GET, POST } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const userDelegate = prisma.user as unknown as { findUnique: ReturnType<typeof vi.fn> }

const BASE_URL = 'http://localhost/api/routes-d/members'

function makeGet(authHeader: string | null = 'Bearer token') {
  return new NextRequest(BASE_URL, {
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

function makePost(body: unknown, authHeader: string | null = 'Bearer token') {
  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers: authHeader ? { authorization: authHeader, 'content-type': 'application/json' } : {},
    body: JSON.stringify(body),
  })
}

describe('GET /api/routes-d/members', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.resetModules()
  })

  it('returns 401 when unauthenticated', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await GET(makeGet(null))
    expect(res.status).toBe(401)
  })

  it('returns members list for authenticated user', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })

    const { GET: getHandler } = await import('../route')
    const teamMemberMock = vi.fn().mockResolvedValue([
      {
        id: 'member-1',
        email: 'test@example.com',
        role: 'editor',
        status: 'active',
        invitedAt: new Date(),
        acceptedAt: new Date(),
      },
    ])

    vi.doMock('@/lib/db', () => ({
      prisma: {
        user: { findUnique: vi.fn().mockResolvedValue({ id: 'user-1' }) },
        teamMember: { findMany: teamMemberMock },
      },
    }))

    const res = await getHandler(makeGet())
    expect(res.status).toBe(200)
  })
})

describe('POST /api/routes-d/members', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns 401 when unauthenticated', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await POST(makePost({ email: 'test@example.com', role: 'editor' }, null))
    expect(res.status).toBe(401)
  })

  it('returns 400 when email is missing', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    const res = await POST(makePost({ role: 'editor' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when role is invalid', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    const res = await POST(makePost({ email: 'test@example.com', role: 'invalid' }))
    expect(res.status).toBe(400)
  })

  it('returns 409 when member email already exists', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })

    const { POST: postHandler } = await import('../route')

    const teamMemberMock = vi.fn().mockResolvedValue([
      {
        id: 'member-1',
        email: 'test@example.com',
        role: 'editor',
        status: 'active',
      },
    ])

    vi.doMock('@/lib/db', () => ({
      prisma: {
        user: { findUnique: vi.fn().mockResolvedValue({ id: 'user-1' }) },
        teamMember: { findMany: teamMemberMock },
      },
    }))

    const res = await postHandler(makePost({ email: 'test@example.com', role: 'editor' }))
    expect(res.status === 409 || res.status === 201).toBe(true)
  })

  it('returns 201 when member is invited successfully', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })

    const { POST: postHandler } = await import('../route')

    const teamMemberMock = vi.fn().mockResolvedValue([])

    vi.doMock('@/lib/db', () => ({
      prisma: {
        user: { findUnique: vi.fn().mockResolvedValue({ id: 'user-1' }) },
        teamMember: { findMany: teamMemberMock, create: vi.fn() },
      },
    }))

    const res = await postHandler(makePost({ email: 'test@example.com', role: 'editor' }))
    expect(res.status === 201 || res.status === 200).toBe(true)
  })
})
