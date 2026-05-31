import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '../unread-count/route'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    notification: { count: vi.fn() },
  },
}))
vi.mock('../../_lib/notification-cache', () => ({
  getCachedUnreadCount: vi.fn(),
  setCachedUnreadCount: vi.fn(),
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getCachedUnreadCount, setCachedUnreadCount } from '../../_lib/notification-cache'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedCount = vi.mocked(prisma.notification.count)
const mockedGetCache = vi.mocked(getCachedUnreadCount)
const mockedSetCache = vi.mocked(setCachedUnreadCount)

function makeRequest() {
  return new NextRequest('http://localhost/api/routes-b/notifications/unread-count', {
    method: 'GET',
    headers: { authorization: 'Bearer token' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedGetCache.mockReturnValue(null)
})

describe('GET /notifications/unread-count', () => {
  it('returns 401 when not authenticated', async () => {
    mockedVerify.mockResolvedValue(null)
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
  })

  it('returns 404 when user not found', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-123' } as any)
    mockedUserFind.mockResolvedValue(null)
    const res = await GET(makeRequest())
    expect(res.status).toBe(404)
  })

  it('returns count from database', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-123' } as any)
    mockedUserFind.mockResolvedValue({ id: 'user-1' } as any)
    mockedCount.mockResolvedValue(7)

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.count).toBe(7)
    expect(mockedSetCache).toHaveBeenCalledWith('user-1', 7)
  })

  it('returns cached count without hitting the database', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-123' } as any)
    mockedUserFind.mockResolvedValue({ id: 'user-1' } as any)
    mockedGetCache.mockReturnValue(3)

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.count).toBe(3)
    expect(mockedCount).not.toHaveBeenCalled()
  })

  it('returns 0 when all notifications are read', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-123' } as any)
    mockedUserFind.mockResolvedValue({ id: 'user-1' } as any)
    mockedCount.mockResolvedValue(0)

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.count).toBe(0)
  })
})
