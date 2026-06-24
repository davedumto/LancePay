import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
  },
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn() },
}))

function makeRequest(token: string | null = 'valid-token') {
  const headers = new Headers()
  if (token) headers.set('authorization', `Bearer ${token}`)
  return new NextRequest('http://localhost/api/routes-d/webhooks/event-catalog', { headers })
}

describe('GET /api/routes-d/webhooks/event-catalog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when the user is not authenticated', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/webhooks/event-catalog/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
  })

  it('returns the available webhook event types', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1', role: 'freelancer' })

    const { GET } = await import('@/app/api/routes-d/webhooks/event-catalog/route')
    const res = await GET(makeRequest())

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.count).toBe(body.eventTypes.length)
    expect(body.eventTypes.map((event: { type: string }) => event.type)).toEqual(
      expect.arrayContaining(['invoice.paid', 'kyc.submitted', 'reconciliation.matched']),
    )
  })
})
