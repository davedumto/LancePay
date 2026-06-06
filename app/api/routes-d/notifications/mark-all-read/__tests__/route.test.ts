import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    notification: { updateMany: vi.fn() },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { POST } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedUpdateMany = vi.mocked(prisma.notification.updateMany)

function req(auth = 'Bearer token'): NextRequest {
  return new NextRequest('http://localhost/api/routes-d/notifications/mark-all-read', {
    method: 'POST',
    headers: auth ? { authorization: auth } : {},
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
  mockedUserFind.mockResolvedValue({ id: 'user-1' } as never)
})

describe('POST /api/routes-d/notifications/mark-all-read', () => {
  it('returns 401 without a valid token', async () => {
    mockedVerify.mockResolvedValue(null as never)
    expect((await POST(req(''))).status).toBe(401)
  })

  it('returns 404 when the user cannot be resolved', async () => {
    mockedUserFind.mockResolvedValue(null as never)
    expect((await POST(req())).status).toBe(404)
  })

  it('marks the user\'s unread notifications read and returns the count', async () => {
    mockedUpdateMany.mockResolvedValue({ count: 3 } as never)
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, updatedCount: 3 })
    expect(mockedUpdateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', isRead: false },
      data: { isRead: true },
    })
  })
})
