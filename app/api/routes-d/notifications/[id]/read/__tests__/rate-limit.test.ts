import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { resetRateLimitBuckets } from '../../../../_lib/rate-limit'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    notification: { findUnique: vi.fn(), update: vi.fn() },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { PATCH } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedNotifFind = vi.mocked(prisma.notification.findUnique)
const mockedNotifUpdate = vi.mocked(prisma.notification.update)

const NOTIF_ID = 'notif-abc'
const USER_ID = 'user-1'

const fakeNotification = {
  id: NOTIF_ID,
  userId: USER_ID,
  type: 'invoice_paid',
  title: 'Invoice Paid',
  message: 'Your invoice has been paid',
  isRead: false,
  createdAt: new Date(),
}

function makePatch(auth = 'Bearer token'): NextRequest {
  return new NextRequest(
    `http://localhost/api/routes-d/notifications/${NOTIF_ID}/read`,
    {
      method: 'PATCH',
      headers: auth ? { authorization: auth } : {},
    },
  )
}

const params = Promise.resolve({ id: NOTIF_ID })

describe('PATCH /api/routes-d/notifications/[id]/read rate limit', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    resetRateLimitBuckets()
    vi.resetAllMocks()
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFind.mockResolvedValue({ id: USER_ID } as never)
    mockedNotifFind.mockResolvedValue(fakeNotification as never)
    mockedNotifUpdate.mockResolvedValue({ ...fakeNotification, isRead: true } as never)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('allows requests under the limit', async () => {
    for (let i = 0; i < 29; i += 1) {
      const res = await PATCH(makePatch(), { params })
      expect(res.status).toBe(200)
    }
  })

  it('allows the request at the limit', async () => {
    for (let i = 0; i < 30; i += 1) {
      const res = await PATCH(makePatch(), { params })
      expect(res.status).toBe(200)
    }
  })

  it('rejects requests over the limit with Retry-After', async () => {
    for (let i = 0; i < 30; i += 1) {
      await PATCH(makePatch(), { params })
    }

    const res = await PATCH(makePatch(), { params })

    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('60')
    expect(mockedNotifUpdate).toHaveBeenCalledTimes(30)
  })

  it('recovers after the window resets', async () => {
    for (let i = 0; i < 30; i += 1) {
      await PATCH(makePatch(), { params })
    }

    vi.setSystemTime(new Date('2026-01-01T00:01:01.000Z'))

    const res = await PATCH(makePatch(), { params })

    expect(res.status).toBe(200)
  })
})
