import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: { user: { findUnique: vi.fn() }, notification: { findMany: vi.fn(), count: vi.fn() } },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedNotifFindMany = vi.mocked(prisma.notification.findMany)
const mockedNotifCount = vi.mocked(prisma.notification.count)

function reqGET(query = '', auth = 'Bearer token'): NextRequest {
  return new NextRequest(`http://localhost/api/routes-d/notifications${query}`, {
    method: 'GET',
    headers: auth ? { authorization: auth } : {},
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
  mockedUserFind.mockResolvedValue({ id: 'user-1' } as never)
})

describe('GET /api/routes-d/notifications', () => {
  it('returns 401 without token', async () => {
    mockedVerify.mockResolvedValue(null as never)
    expect((await GET(reqGET(''))).status).toBe(401)
  })

  it('returns 404 if user not found', async () => {
    mockedUserFind.mockResolvedValue(null as never)
    expect((await GET(reqGET())).status).toBe(404)
  })

  it('returns notifications and unread count', async () => {
    mockedNotifFindMany.mockResolvedValue([{ id: '1', title: 'Test' }] as never)
    mockedNotifCount.mockResolvedValue(1 as never)

    const res = await GET(reqGET())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.notifications).toHaveLength(1)
    expect(json.unreadCount).toBe(1)
  })

  it('filters by unread=true', async () => {
    mockedNotifFindMany.mockResolvedValue([{ id: '1', title: 'Test', isRead: false }] as never)
    mockedNotifCount.mockResolvedValue(1 as never)

    const res = await GET(reqGET('?unread=true'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.notifications).toHaveLength(1)
    expect(json.unreadCount).toBe(1)
    expect(mockedNotifFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user-1', isRead: false } }))
  })
})
