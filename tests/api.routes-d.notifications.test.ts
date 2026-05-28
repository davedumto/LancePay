import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const findUnique = vi.fn()
const notificationFindMany = vi.fn()
const notificationCount = vi.fn()
const loggerError = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique },
    notification: { findMany: notificationFindMany, count: notificationCount },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: loggerError } }))

const BASE_URL = 'http://localhost/api/routes-d/notifications'

function makeRequest(query = '') {
  return new NextRequest(`${BASE_URL}${query}`, {
    method: 'GET',
    headers: { authorization: 'Bearer token' },
  })
}

function encodeCursor(payload: { createdAt: string; id: string }) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

describe('GET /api/routes-d/notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns a limited page and nextCursor when more notifications exist', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    findUnique.mockResolvedValue({ id: 'user_1' })
    notificationFindMany.mockResolvedValue([
      { id: 'note_3', type: 'invoice', title: 'Third', message: 'Message', isRead: false, createdAt: new Date('2026-01-03T00:00:00.000Z') },
      { id: 'note_2', type: 'invoice', title: 'Second', message: 'Message', isRead: false, createdAt: new Date('2026-01-02T00:00:00.000Z') },
      { id: 'note_1', type: 'invoice', title: 'First', message: 'Message', isRead: true, createdAt: new Date('2026-01-01T00:00:00.000Z') },
    ])
    notificationCount.mockResolvedValue(2)

    const { GET } = await import('@/app/api/routes-d/notifications/route')
    const res = await GET(makeRequest('?limit=2'))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.notifications).toHaveLength(2)
    expect(json.unreadCount).toBe(2)
    expect(json.nextCursor).toBe(encodeCursor({ createdAt: '2026-01-02T00:00:00.000Z', id: 'note_2' }))
    expect(notificationFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user_1' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 3,
    }))
  })

  it('applies unread and cursor filters', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    findUnique.mockResolvedValue({ id: 'user_1' })
    notificationFindMany.mockResolvedValue([])
    notificationCount.mockResolvedValue(0)
    const cursor = encodeCursor({ createdAt: '2026-01-02T00:00:00.000Z', id: 'note_2' })

    const { GET } = await import('@/app/api/routes-d/notifications/route')
    const res = await GET(makeRequest(`?unread=true&cursor=${cursor}&limit=5`))

    expect(res.status).toBe(200)
    expect(notificationFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        userId: 'user_1',
        isRead: false,
        OR: [
          { createdAt: { lt: new Date('2026-01-02T00:00:00.000Z') } },
          {
            AND: [
              { createdAt: new Date('2026-01-02T00:00:00.000Z') },
              { id: { lt: 'note_2' } },
            ],
          },
        ],
      },
      take: 6,
    }))
  })

  it('returns 400 for an invalid cursor', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    findUnique.mockResolvedValue({ id: 'user_1' })

    const { GET } = await import('@/app/api/routes-d/notifications/route')
    const res = await GET(makeRequest('?cursor=not-a-valid-cursor'))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid cursor' })
    expect(notificationFindMany).not.toHaveBeenCalled()
  })
})
