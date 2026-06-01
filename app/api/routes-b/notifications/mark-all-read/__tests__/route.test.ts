import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('../../../_lib/notification-cache', () => ({
  bustUnreadCountCache: vi.fn(),
}))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    notification: { updateMany: vi.fn() },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { bustUnreadCountCache } from '../../../_lib/notification-cache'
import { POST } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedUpdateMany = vi.mocked(prisma.notification.updateMany)
const mockedBustCache = vi.mocked(bustUnreadCountCache)

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/routes-b/notifications/mark-all-read', {
    method: 'POST',
    headers: { authorization: 'Bearer token', ...headers },
  })
}

describe('POST /api/routes-b/notifications/mark-all-read', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFind.mockResolvedValue({ id: 'user-1' } as never)
    mockedUpdateMany.mockResolvedValue({ count: 4 } as never)
  })

  it('marks unread notifications and returns the updated count', async () => {
    const res = await POST(makeRequest())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ updated: 4 })
    expect(mockedUpdateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', isRead: false },
      data: { isRead: true },
    })
    expect(mockedBustCache).toHaveBeenCalledWith('user-1')
  })

  it('returns 401 without an authorization header', async () => {
    const res = await POST(
      new NextRequest('http://localhost/api/routes-b/notifications/mark-all-read', {
        method: 'POST',
      }),
    )
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toMatchObject({ code: 'UNAUTHORIZED', message: 'Unauthorized' })
  })

  it('returns 401 when the token is invalid', async () => {
    mockedVerify.mockResolvedValueOnce(null as never)
    const res = await POST(makeRequest())
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toMatchObject({ code: 'UNAUTHORIZED', message: 'Invalid token' })
  })

  it('returns 404 when the user cannot be resolved', async () => {
    mockedUserFind.mockResolvedValueOnce(null as never)
    const res = await POST(makeRequest())
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toMatchObject({ code: 'NOT_FOUND', message: 'User not found' })
  })

  it('returns structured error on unexpected failure', async () => {
    mockedUpdateMany.mockRejectedValueOnce(new Error('database unavailable'))
    const res = await POST(makeRequest({ 'x-request-id': 'req-error-2' }))
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error).toMatchObject({
      code: 'INTERNAL',
      message: 'Failed to mark notifications as read',
    })
    expect(json.requestId).toBeTruthy()
  })
})
