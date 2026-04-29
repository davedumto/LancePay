import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from '../notifications/route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { NextRequest } from 'next/server'
import { encodeCursor } from '../_lib/cursor'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    notification: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}))

function makeReq(url: string) {
  return new NextRequest(url, {
    headers: { authorization: 'Bearer valid-token' },
  })
}

describe('Notifications Pagination API', () => {
  const mockUser = { id: 'user-1', privyId: 'privy-1' }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
    vi.mocked(prisma.notification.count).mockResolvedValue(5)
  })

  it('returns first page of notifications with default limit (20)', async () => {
    const mockNotifications = Array.from({ length: 21 }, (_, i) => ({
      id: `notif-${i}`,
      createdAt: new Date(2026, 0, 30 - i),
      title: `Notif ${i}`,
      message: 'Hello',
      type: 'info',
      isRead: false
    }))
    
    vi.mocked(prisma.notification.findMany).mockResolvedValue(mockNotifications as any)

    const req = makeReq('http://localhost/api/routes-b/notifications')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data).toHaveLength(20)
    expect(body.nextCursor).toBeDefined()
    expect(body.unreadCount).toBe(5)
    
    expect(prisma.notification.findMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 21,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
    }))
  })

  it('walks cursor correctly', async () => {
    const lastDate = new Date('2026-01-15T10:00:00.000Z')
    const cursor = encodeCursor({ createdAt: lastDate.toISOString(), id: 'last-id' })
    
    vi.mocked(prisma.notification.findMany).mockResolvedValue([])

    const req = makeReq(`http://localhost/api/routes-b/notifications?cursor=${cursor}`)
    await GET(req)

    expect(prisma.notification.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: [
          { createdAt: { lt: lastDate } },
          {
            AND: [
              { createdAt: lastDate },
              { id: { lt: 'last-id' } }
            ]
          }
        ]
      })
    }))
  })

  it('returns no nextCursor on the last page', async () => {
    vi.mocked(prisma.notification.findMany).mockResolvedValue([
      { id: 'last', createdAt: new Date(), title: 'Last', message: 'x', type: 'y', isRead: false }
    ] as any)

    const req = makeReq('http://localhost/api/routes-b/notifications?limit=5')
    const res = await GET(req)
    const body = await res.json()

    expect(body.data).toHaveLength(1)
    expect(body.nextCursor).toBeNull()
  })

  it('returns 400 for invalid cursor', async () => {
    const req = makeReq('http://localhost/api/routes-b/notifications?cursor=invalid')
    const res = await GET(req)
    
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Invalid cursor')
  })
})
