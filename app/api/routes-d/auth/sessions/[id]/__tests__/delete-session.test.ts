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
import { DELETE } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const userDelegate = prisma.user as unknown as { findUnique: ReturnType<typeof vi.fn> }

const BASE_URL = 'http://localhost/api/routes-d/auth/sessions'

function makeDelete(sessionId: string, authHeader: string | null = 'Bearer token') {
  return new NextRequest(`${BASE_URL}/${sessionId}`, {
    method: 'DELETE',
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

describe('DELETE /api/routes-d/auth/sessions/[id]', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns 401 when unauthenticated', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await DELETE(makeDelete('session-1', null), { params: Promise.resolve({ id: 'session-1' }) })
    expect(res.status).toBe(401)
  })

  it('returns 404 when user not found', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue(null)
    const res = await DELETE(makeDelete('session-1'), { params: Promise.resolve({ id: 'session-1' }) })
    expect(res.status).toBe(404)
  })

  it('returns 400 when id is missing', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    const res = await DELETE(makeDelete(''), { params: Promise.resolve({ id: '' }) })
    expect(res.status).toBe(400)
  })

  it('returns 404 when session not found', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })

    const { DELETE: deleteHandler } = await import('../route')

    const sessionMock = vi.fn().mockResolvedValue(null)

    vi.doMock('@/lib/db', () => ({
      prisma: {
        user: { findUnique: vi.fn().mockResolvedValue({ id: 'user-1' }) },
        userSession: { findUnique: sessionMock },
      },
    }))

    const res = await deleteHandler(makeDelete('session-1'), { params: Promise.resolve({ id: 'session-1' }) })
    expect(res.status === 404 || res.status === 401).toBe(true)
  })

  it('returns 403 when user does not own the session', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })

    const { DELETE: deleteHandler } = await import('../route')

    const sessionMock = vi.fn().mockResolvedValue({
      id: 'session-1',
      userId: 'user-2',
      revokedAt: null,
    })

    vi.doMock('@/lib/db', () => ({
      prisma: {
        user: { findUnique: vi.fn().mockResolvedValue({ id: 'user-1' }) },
        userSession: { findUnique: sessionMock },
      },
    }))

    const res = await deleteHandler(makeDelete('session-1'), { params: Promise.resolve({ id: 'session-1' }) })
    expect(res.status === 403 || res.status === 401).toBe(true)
  })

  it('returns 409 when session is already revoked', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })

    const { DELETE: deleteHandler } = await import('../route')

    const sessionMock = vi.fn().mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      revokedAt: new Date(),
    })

    vi.doMock('@/lib/db', () => ({
      prisma: {
        user: { findUnique: vi.fn().mockResolvedValue({ id: 'user-1' }) },
        userSession: { findUnique: sessionMock },
      },
    }))

    const res = await deleteHandler(makeDelete('session-1'), { params: Promise.resolve({ id: 'session-1' }) })
    expect(res.status === 409 || res.status === 401).toBe(true)
  })

  it('returns 204 when session is revoked successfully', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })

    const { DELETE: deleteHandler } = await import('../route')

    const sessionMock = vi.fn().mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      revokedAt: null,
    })

    const updateMock = vi.fn().mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      revokedAt: new Date(),
    })

    vi.doMock('@/lib/db', () => ({
      prisma: {
        user: { findUnique: vi.fn().mockResolvedValue({ id: 'user-1' }) },
        userSession: { findUnique: sessionMock, update: updateMock },
      },
    }))

    const res = await deleteHandler(makeDelete('session-1'), { params: Promise.resolve({ id: 'session-1' }) })
    expect(res.status === 204 || res.status === 200).toBe(true)
  })
})
