import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const findUnique = vi.fn()
const prefUpsert = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique },
    notificationPreference: { upsert: prefUpsert },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

const URL = 'http://localhost/api/routes-d/quiet-hours'

function req(body: object) {
  return new NextRequest(URL, {
    method: 'POST',
    headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/routes-d/quiet-hours', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 with no token', async () => {
    const { POST } = await import('@/app/api/routes-d/quiet-hours/route')
    const res = await POST(new NextRequest(URL, { method: 'POST' }))
    expect(res.status).toBe(401)
  })

  it('returns 422 when enabled is not boolean', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    const { POST } = await import('@/app/api/routes-d/quiet-hours/route')
    const res = await POST(req({ enabled: 'yes' }))
    expect(res.status).toBe(422)
  })

  it('returns 422 when startTime format is invalid', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    const { POST } = await import('@/app/api/routes-d/quiet-hours/route')
    const res = await POST(req({ enabled: true, startTime: '25:00', endTime: '08:00' }))
    expect(res.status).toBe(422)
  })

  it('saves quiet hours and returns 200', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    prefUpsert.mockResolvedValue({ id: 'pref-1', quietHours: { enabled: true }, updatedAt: new Date() })
    const { POST } = await import('@/app/api/routes-d/quiet-hours/route')
    const res = await POST(req({ enabled: true, startTime: '22:00', endTime: '08:00' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.preference).toBeDefined()
  })
})
