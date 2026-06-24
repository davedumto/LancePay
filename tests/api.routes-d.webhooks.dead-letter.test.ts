import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const deliveryFindMany = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    webhookDelivery: { findMany: deliveryFindMany },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

const URL = 'http://localhost/api/routes-d/webhooks/dead-letter'

describe('GET /api/routes-d/webhooks/dead-letter', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when unauthenticated', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/webhooks/dead-letter/route')
    const res = await GET(new NextRequest(URL))
    expect(res.status).toBe(401)
  })

  it('returns empty list when no dead-letter entries exist', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    deliveryFindMany.mockResolvedValue([])
    const { GET } = await import('@/app/api/routes-d/webhooks/dead-letter/route')
    const res = await GET(new NextRequest(URL, { headers: { authorization: 'Bearer tok' } }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.entries).toHaveLength(0)
  })

  it('returns dead-letter entries scoped to the authenticated user', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    deliveryFindMany.mockResolvedValue([
      {
        id: 'dl1',
        webhookId: 'wh1',
        eventType: 'invoice.paid',
        status: 'dead',
        attemptCount: 5,
        lastAttemptAt: new Date(),
        lastStatusCode: 500,
        lastError: 'Internal Server Error',
        createdAt: new Date(),
      },
    ])
    const { GET } = await import('@/app/api/routes-d/webhooks/dead-letter/route')
    const res = await GET(new NextRequest(URL, { headers: { authorization: 'Bearer tok' } }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0].status).toBe('dead')
    expect(deliveryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'dead' }) }),
    )
  })

  it('passes userId filter through webhook relation', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    deliveryFindMany.mockResolvedValue([])
    const { GET } = await import('@/app/api/routes-d/webhooks/dead-letter/route')
    await GET(new NextRequest(URL, { headers: { authorization: 'Bearer tok' } }))
    expect(deliveryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          webhook: { userId: 'user_1' },
        }),
      }),
    )
  })
})
