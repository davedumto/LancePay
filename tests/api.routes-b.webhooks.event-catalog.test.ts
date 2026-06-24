import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { VALID_EVENT_TYPES } from '@/app/api/routes-b/_lib/webhook-events'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
  },
}))

const BASE_URL = 'http://localhost/api/routes-b/webhooks/event-catalog'

function makeRequest(opts?: { auth?: string }) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const auth = opts?.auth ?? 'Bearer token'
  if (auth) headers.authorization = auth
  return new NextRequest(BASE_URL, {
    method: 'GET',
    headers,
  })
}

describe('GET /api/routes-b/webhooks/event-catalog', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when no auth is supplied', async () => {
    const { GET } = await import('@/app/api/routes-b/webhooks/event-catalog/route')
    const res = await GET(makeRequest({ auth: '' }))
    expect(res.status).toBe(401)
  })

  it('returns 200 and lists event catalog successfully', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const { GET } = await import('@/app/api/routes-b/webhooks/event-catalog/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)

    const data = await res.json()
    expect(data.eventTypes).toEqual(VALID_EVENT_TYPES)
  })
})
