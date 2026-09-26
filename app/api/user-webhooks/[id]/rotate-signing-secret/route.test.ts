import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PATCH } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    userWebhook: { findUnique: vi.fn(), update: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUser = { id: 'user-1', role: 'freelancer', email: 'user@test.com' }
const mockClaims = { userId: 'privy-1' }
const mockWebhook = {
  id: 'wh-1',
  userId: 'user-1',
  signingSecret: 'old-secret',
}

function makeRequest(body?: unknown): NextRequest {
  return new NextRequest(
    'http://localhost/api/user-webhooks/wh-1/rotate-signing-secret',
    {
      method: 'PATCH',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  )
}

const params = { params: Promise.resolve({ id: 'wh-1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
  vi.mocked(prisma.userWebhook.findUnique).mockResolvedValue(mockWebhook as any)
  vi.mocked(prisma.userWebhook.update).mockResolvedValue({} as any)
})

describe('PATCH /api/user-webhooks/[id]/rotate-signing-secret', () => {
  it('rotates the secret and keeps the previous one for the grace window', async () => {
    const res = await PATCH(makeRequest(), params)
    const data = await res.json()

    expect(res.status).toBe(200)
    // New secret returned once, and is not the old one.
    expect(typeof data.signingSecret).toBe('string')
    expect(data.signingSecret).not.toBe('old-secret')
    expect(data.signingSecret.length).toBe(64) // 32 random bytes as hex
    expect(data.previousSecretValidUntil).not.toBeNull()

    const updateArg = vi.mocked(prisma.userWebhook.update).mock.calls[0][0] as any
    expect(updateArg.data.previousSigningSecret).toBe('old-secret')
    expect(updateArg.data.signingSecret).toBe(data.signingSecret)
    expect(updateArg.data.signingSecretExpiresAt).toBeInstanceOf(Date)
  })

  it('drops the previous secret immediately when graceWindowMs is 0', async () => {
    const res = await PATCH(makeRequest({ graceWindowMs: 0 }), params)
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.previousSecretValidUntil).toBeNull()
    const updateArg = vi.mocked(prisma.userWebhook.update).mock.calls[0][0] as any
    expect(updateArg.data.previousSigningSecret).toBeNull()
    expect(updateArg.data.signingSecretExpiresAt).toBeNull()
  })

  it('rejects an out-of-range graceWindowMs', async () => {
    const res = await PATCH(makeRequest({ graceWindowMs: 999999999999 }), params)
    expect(res.status).toBe(400)
    expect(vi.mocked(prisma.userWebhook.update)).not.toHaveBeenCalled()
  })

  it('forbids rotating a webhook the caller does not own', async () => {
    vi.mocked(prisma.userWebhook.findUnique).mockResolvedValue({
      ...mockWebhook,
      userId: 'someone-else',
    } as any)
    const res = await PATCH(makeRequest(), params)
    expect(res.status).toBe(403)
    expect(vi.mocked(prisma.userWebhook.update)).not.toHaveBeenCalled()
  })

  it('returns 404 when the webhook does not exist', async () => {
    vi.mocked(prisma.userWebhook.findUnique).mockResolvedValue(null)
    const res = await PATCH(makeRequest(), params)
    expect(res.status).toBe(404)
  })

  it('returns 401 when no token', async () => {
    const req = new NextRequest(
      'http://localhost/api/user-webhooks/wh-1/rotate-signing-secret',
      { method: 'PATCH' },
    )
    const res = await PATCH(req, params)
    expect(res.status).toBe(401)
  })

  it('returns 401 when token invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await PATCH(makeRequest(), params)
    expect(res.status).toBe(401)
  })

  it('returns 404 when user not found', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    const res = await PATCH(makeRequest(), params)
    expect(res.status).toBe(404)
  })

  it('returns 500 on unexpected error', async () => {
    vi.mocked(prisma.userWebhook.update).mockRejectedValue(new Error('DB error'))
    const res = await PATCH(makeRequest(), params)
    expect(res.status).toBe(500)
  })
})
