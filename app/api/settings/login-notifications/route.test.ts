import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET, PATCH } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    loginNotificationSettings: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const USER_ID = '11111111-1111-4111-8111-111111111111'

function makeRequest(method: string, body?: unknown, token = 'user-token'): NextRequest {
  return new NextRequest('http://localhost/api/settings/login-notifications', {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-user' } as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: USER_ID, email: 'user@example.com' } as any)
})

// ─── GET ─────────────────────────────────────────────────────────────────────

describe('GET /api/settings/login-notifications', () => {
  it('returns defaults when no settings row exists yet', async () => {
    vi.mocked(prisma.loginNotificationSettings.findUnique).mockResolvedValue(null)

    const res = await GET(makeRequest('GET'))
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.settings.notifyOnNewDevice).toBe(true)
    expect(data.settings.notifyEmail).toBeNull()
    expect(data.settings.updatedAt).toBeNull()
  })

  it('returns persisted settings when a row exists', async () => {
    vi.mocked(prisma.loginNotificationSettings.findUnique).mockResolvedValue({
      notifyOnNewDevice: false,
      notifyEmail: 'alerts@example.com',
      updatedAt: new Date('2026-07-01T00:00:00Z'),
    } as any)

    const res = await GET(makeRequest('GET'))
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.settings.notifyOnNewDevice).toBe(false)
    expect(data.settings.notifyEmail).toBe('alerts@example.com')
  })

  it('returns 401 when no authorization header is present', async () => {
    const res = await GET(
      new NextRequest('http://localhost/api/settings/login-notifications', { method: 'GET' }),
    )
    expect(res.status).toBe(401)
  })

  it('returns 401 when the token is invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await GET(makeRequest('GET'))
    expect(res.status).toBe(401)
  })

  it('returns 404 when the user does not exist', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    const res = await GET(makeRequest('GET'))
    expect(res.status).toBe(404)
  })

  it('returns 500 when the database throws', async () => {
    vi.mocked(prisma.loginNotificationSettings.findUnique).mockRejectedValue(new Error('DB failure'))

    const res = await GET(makeRequest('GET'))
    const data = await res.json()

    expect(res.status).toBe(500)
    expect(data.error).toBe('Failed to fetch login notification settings')
  })
})

// ─── PATCH ───────────────────────────────────────────────────────────────────

describe('PATCH /api/settings/login-notifications', () => {
  const updatedRow = (overrides = {}) => ({
    notifyOnNewDevice: true,
    notifyEmail: null,
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  })

  it('updates notifyOnNewDevice to false', async () => {
    vi.mocked(prisma.loginNotificationSettings.upsert).mockResolvedValue(
      updatedRow({ notifyOnNewDevice: false }) as any,
    )

    const res = await PATCH(makeRequest('PATCH', { notifyOnNewDevice: false }))
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.settings.notifyOnNewDevice).toBe(false)
  })

  it('updates notifyOnNewDevice to true', async () => {
    vi.mocked(prisma.loginNotificationSettings.upsert).mockResolvedValue(
      updatedRow({ notifyOnNewDevice: true }) as any,
    )

    const res = await PATCH(makeRequest('PATCH', { notifyOnNewDevice: true }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.settings.notifyOnNewDevice).toBe(true)
  })

  it('updates notifyEmail with a valid address', async () => {
    vi.mocked(prisma.loginNotificationSettings.upsert).mockResolvedValue(
      updatedRow({ notifyEmail: 'ops@example.com' }) as any,
    )

    const res = await PATCH(makeRequest('PATCH', { notifyEmail: 'ops@example.com' }))
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.settings.notifyEmail).toBe('ops@example.com')
  })

  it('clears notifyEmail when explicitly set to null', async () => {
    vi.mocked(prisma.loginNotificationSettings.upsert).mockResolvedValue(
      updatedRow({ notifyEmail: null }) as any,
    )

    const res = await PATCH(makeRequest('PATCH', { notifyEmail: null }))
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.settings.notifyEmail).toBeNull()
  })

  it('upserts on first call (create path)', async () => {
    vi.mocked(prisma.loginNotificationSettings.upsert).mockResolvedValue(
      updatedRow({ notifyOnNewDevice: false }) as any,
    )

    await PATCH(makeRequest('PATCH', { notifyOnNewDevice: false }))

    expect(vi.mocked(prisma.loginNotificationSettings.upsert)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER_ID },
        create: expect.objectContaining({ userId: USER_ID, notifyOnNewDevice: false }),
        update: expect.objectContaining({ notifyOnNewDevice: false }),
      }),
    )
  })

  it('returns 400 for a non-boolean notifyOnNewDevice', async () => {
    const res = await PATCH(makeRequest('PATCH', { notifyOnNewDevice: 'yes' }))
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain('notifyOnNewDevice')
  })

  it('returns 400 for an invalid notifyEmail', async () => {
    const res = await PATCH(makeRequest('PATCH', { notifyEmail: 'not-an-email' }))
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain('notifyEmail')
  })

  it('returns 400 when no recognised fields are provided', async () => {
    const res = await PATCH(makeRequest('PATCH', {}))
    expect(res.status).toBe(400)
  })

  it('returns 400 for malformed JSON', async () => {
    const res = await PATCH(
      new NextRequest('http://localhost/api/settings/login-notifications', {
        method: 'PATCH',
        headers: { authorization: 'Bearer user-token', 'content-type': 'application/json' },
        body: '{bad-json}',
      }),
    )
    expect(res.status).toBe(400)
  })

  it('returns 401 when no authorization header is present', async () => {
    const res = await PATCH(
      new NextRequest('http://localhost/api/settings/login-notifications', { method: 'PATCH' }),
    )
    expect(res.status).toBe(401)
  })

  it('returns 401 when the token is invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await PATCH(makeRequest('PATCH', { notifyOnNewDevice: false }))
    expect(res.status).toBe(401)
  })

  it('returns 404 when the user does not exist', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    const res = await PATCH(makeRequest('PATCH', { notifyOnNewDevice: false }))
    expect(res.status).toBe(404)
  })

  it('returns 500 when the database throws', async () => {
    vi.mocked(prisma.loginNotificationSettings.upsert).mockRejectedValue(new Error('DB failure'))

    const res = await PATCH(makeRequest('PATCH', { notifyOnNewDevice: false }))
    const data = await res.json()

    expect(res.status).toBe(500)
    expect(data.error).toBe('Failed to update login notification settings')
  })
})
