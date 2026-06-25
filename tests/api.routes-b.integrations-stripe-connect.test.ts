import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const findUnique = vi.fn()
const integrationFindFirst = vi.fn()
const integrationUpsert = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique },
    integration: { findFirst: integrationFindFirst, upsert: integrationUpsert },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

const URL = 'http://localhost/api/routes-b/integrations/stripe/connect'

function req(body: object, token: string | null = 'tok') {
  const h = new Headers({ 'content-type': 'application/json' })
  if (token) h.set('authorization', `Bearer ${token}`)
  return new NextRequest(URL, { method: 'POST', headers: h, body: JSON.stringify(body) })
}

describe('POST /api/routes-b/integrations/stripe/connect', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 with invalid token', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-b/integrations/stripe/connect/route')
    const res = await POST(req({ code: 'ac_123' }))
    expect(res.status).toBe(401)
  })

  it('returns 422 when code is missing', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    integrationFindFirst.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-b/integrations/stripe/connect/route')
    const res = await POST(req({}))
    expect(res.status).toBe(422)
  })

  it('returns 409 when stripe already connected', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    integrationFindFirst.mockResolvedValue({ id: 'int-1', enabled: true })
    const { POST } = await import('@/app/api/routes-b/integrations/stripe/connect/route')
    const res = await POST(req({ code: 'ac_123' }))
    expect(res.status).toBe(409)
  })

  it('connects stripe and returns 201', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    integrationFindFirst.mockResolvedValue(null)
    integrationUpsert.mockResolvedValue({ id: 'int-1', type: 'stripe', enabled: true, updatedAt: new Date() })
    const { POST } = await import('@/app/api/routes-b/integrations/stripe/connect/route')
    const res = await POST(req({ code: 'ac_123' }))
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.integration.type).toBe('stripe')
  })
})
