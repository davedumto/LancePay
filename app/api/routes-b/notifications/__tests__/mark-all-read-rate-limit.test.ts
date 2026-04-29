import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '../mark-all-read/route'
import { resetRateLimitBuckets } from '../../_lib/rate-limit'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    notification: { updateMany: vi.fn() },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFindUnique = vi.mocked(prisma.user.findUnique)
const mockedUpdateMany = vi.mocked(prisma.notification.updateMany)

function makeRequest() {
  return new NextRequest('http://localhost/api/routes-b/notifications/mark-all-read', {
    method: 'POST',
    headers: { authorization: 'Bearer token' },
  })
}

describe('POST /api/routes-b/notifications/mark-all-read rate limit', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    resetRateLimitBuckets()
    vi.resetAllMocks()
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFindUnique.mockResolvedValue({ id: 'user-1' } as never)
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never)
  })

  it('allows requests under the limit', async () => {
    for (let i = 0; i < 4; i += 1) {
      const res = await POST(makeRequest())
      expect(res.status).toBe(200)
    }
  })

  it('allows the request at the limit', async () => {
    for (let i = 0; i < 5; i += 1) {
      const res = await POST(makeRequest())
      expect(res.status).toBe(200)
    }
  })

  it('rejects requests over the limit with Retry-After', async () => {
    for (let i = 0; i < 5; i += 1) {
      await POST(makeRequest())
    }

    const res = await POST(makeRequest())

    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('60')
    expect(mockedUpdateMany).toHaveBeenCalledTimes(5)
  })

  it('recovers after the window resets', async () => {
    for (let i = 0; i < 5; i += 1) {
      await POST(makeRequest())
    }

    vi.setSystemTime(new Date('2026-01-01T00:01:01.000Z'))

    const res = await POST(makeRequest())

    expect(res.status).toBe(200)
  })
})
