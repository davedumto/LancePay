import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

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

beforeEach(() => {
  vi.resetAllMocks()
  mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
  mockedUserFind.mockResolvedValue({ id: USER_ID } as never)
  mockedNotifFind.mockResolvedValue(fakeNotification as never)
  mockedNotifUpdate.mockResolvedValue({ ...fakeNotification, isRead: true } as never)
})

describe('PATCH /api/routes-d/notifications/[id]/read', () => {
  it('returns 401 without authorization header', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await PATCH(makePatch(''), { params })
    expect(res.status).toBe(401)
  })

  it('returns 401 with invalid token', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await PATCH(makePatch('Bearer bad-token'), { params })
    expect(res.status).toBe(401)
  })

  it('returns 404 when user is not found', async () => {
    mockedUserFind.mockResolvedValue(null as never)
    const res = await PATCH(makePatch(), { params })
    expect(res.status).toBe(404)
  })

  it('returns 404 when notification does not exist', async () => {
    mockedNotifFind.mockResolvedValue(null as never)
    const res = await PATCH(makePatch(), { params })
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toBe('Notification not found')
  })

  it('returns 403 when notification belongs to another user', async () => {
    mockedNotifFind.mockResolvedValue({ ...fakeNotification, userId: 'other-user' } as never)
    const res = await PATCH(makePatch(), { params })
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.error).toMatch(/not authorized/i)
  })

  it('marks an unread notification as read and returns success', async () => {
    const updated = { ...fakeNotification, isRead: true }
    mockedNotifUpdate.mockResolvedValue(updated as never)

    const res = await PATCH(makePatch(), { params })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.notification.isRead).toBe(true)
    expect(mockedNotifUpdate).toHaveBeenCalledWith({
      where: { id: NOTIF_ID },
      data: { isRead: true },
    })
  })

  it('is idempotent — marking an already-read notification returns 200', async () => {
    mockedNotifFind.mockResolvedValue({ ...fakeNotification, isRead: true } as never)
    mockedNotifUpdate.mockResolvedValue({ ...fakeNotification, isRead: true } as never)

    const res = await PATCH(makePatch(), { params })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
  })
})