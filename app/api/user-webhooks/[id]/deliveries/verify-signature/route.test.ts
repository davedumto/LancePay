import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from './route'
import { NextRequest } from 'next/server'
import { computeWebhookSignature } from '@/lib/webhook-signature'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    userWebhook: { findUnique: vi.fn() },
    webhookDelivery: { findUnique: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUser = { id: 'user-1', role: 'freelancer', email: 'user@test.com' }
const mockAdmin = { id: 'admin-1', role: 'admin', email: 'admin@test.com' }
const mockOther = { id: 'user-2', role: 'freelancer', email: 'other@test.com' }
const mockClaims = { userId: 'privy-1' }

const PAYLOAD = JSON.stringify({ event: 'invoice.paid', id: 'inv-1' })
const CURRENT_SECRET = 'current-secret'
const PREVIOUS_SECRET = 'previous-secret'

const mockWebhook = {
  id: 'wh-1',
  userId: 'user-1',
  signingSecret: CURRENT_SECRET,
  previousSigningSecret: null as string | null,
  signingSecretExpiresAt: null as Date | null,
}
const mockDelivery = { id: 'del-1', webhookId: 'wh-1', payload: PAYLOAD }

function makeRequest(params: Record<string, string>): NextRequest {
  const url = new URL('http://localhost/api/user-webhooks/wh-1/deliveries/verify-signature')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new NextRequest(url.toString(), { headers: { authorization: 'Bearer token' } })
}

const params = { params: Promise.resolve({ id: 'wh-1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
  vi.mocked(prisma.userWebhook.findUnique).mockResolvedValue({ ...mockWebhook } as any)
  vi.mocked(prisma.webhookDelivery.findUnique).mockResolvedValue({ ...mockDelivery } as any)
})

describe('GET /api/user-webhooks/[id]/deliveries/verify-signature', () => {
  it('returns valid=true for a correct signature', async () => {
    const sig = computeWebhookSignature(PAYLOAD, CURRENT_SECRET)
    const res = await GET(makeRequest({ deliveryId: 'del-1', signature: sig }), params)
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.valid).toBe(true)
    expect(data.matchedSecret).toBe('current')
    expect(data.algorithm).toBe('HMAC-SHA256')
    // Never leak the secret or the expected signature.
    expect(JSON.stringify(data)).not.toContain(CURRENT_SECRET)
    expect(data.expectedSignature).toBeUndefined()
  })

  it('returns valid=false for a wrong signature', async () => {
    const res = await GET(
      makeRequest({ deliveryId: 'del-1', signature: 'sha256=deadbeef' }),
      params,
    )
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.valid).toBe(false)
    expect(data.matchedSecret).toBeNull()
  })

  it('accepts the previous secret while inside the grace window', async () => {
    vi.mocked(prisma.userWebhook.findUnique).mockResolvedValue({
      ...mockWebhook,
      previousSigningSecret: PREVIOUS_SECRET,
      signingSecretExpiresAt: new Date(Date.now() + 60_000),
    } as any)
    const sig = computeWebhookSignature(PAYLOAD, PREVIOUS_SECRET)
    const res = await GET(makeRequest({ deliveryId: 'del-1', signature: sig }), params)
    const data = await res.json()
    expect(data.valid).toBe(true)
    expect(data.matchedSecret).toBe('previous')
  })

  it('rejects the previous secret after the grace window expires', async () => {
    vi.mocked(prisma.userWebhook.findUnique).mockResolvedValue({
      ...mockWebhook,
      previousSigningSecret: PREVIOUS_SECRET,
      signingSecretExpiresAt: new Date(Date.now() - 60_000),
    } as any)
    const sig = computeWebhookSignature(PAYLOAD, PREVIOUS_SECRET)
    const res = await GET(makeRequest({ deliveryId: 'del-1', signature: sig }), params)
    const data = await res.json()
    expect(data.valid).toBe(false)
  })

  it('allows an admin who is not the owner', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockAdmin as any)
    const sig = computeWebhookSignature(PAYLOAD, CURRENT_SECRET)
    const res = await GET(makeRequest({ deliveryId: 'del-1', signature: sig }), params)
    expect(res.status).toBe(200)
  })

  it('forbids a non-owner non-admin', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockOther as any)
    const res = await GET(
      makeRequest({ deliveryId: 'del-1', signature: 'sha256=x' }),
      params,
    )
    expect(res.status).toBe(403)
  })

  it('returns 400 when deliveryId missing', async () => {
    const res = await GET(makeRequest({ signature: 'sha256=x' }), params)
    expect(res.status).toBe(400)
  })

  it('returns 400 when signature missing', async () => {
    const res = await GET(makeRequest({ deliveryId: 'del-1' }), params)
    expect(res.status).toBe(400)
  })

  it('returns 404 when the delivery belongs to another webhook', async () => {
    vi.mocked(prisma.webhookDelivery.findUnique).mockResolvedValue({
      ...mockDelivery,
      webhookId: 'wh-other',
    } as any)
    const res = await GET(
      makeRequest({ deliveryId: 'del-1', signature: 'sha256=x' }),
      params,
    )
    expect(res.status).toBe(404)
  })

  it('returns 404 when the webhook does not exist', async () => {
    vi.mocked(prisma.userWebhook.findUnique).mockResolvedValue(null)
    const res = await GET(
      makeRequest({ deliveryId: 'del-1', signature: 'sha256=x' }),
      params,
    )
    expect(res.status).toBe(404)
  })

  it('returns 401 when token invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await GET(makeRequest({ deliveryId: 'del-1', signature: 'sha256=x' }), params)
    expect(res.status).toBe(401)
  })

  it('returns 500 on unexpected error', async () => {
    vi.mocked(prisma.webhookDelivery.findUnique).mockRejectedValue(new Error('DB error'))
    const res = await GET(
      makeRequest({ deliveryId: 'del-1', signature: 'sha256=x' }),
      params,
    )
    expect(res.status).toBe(500)
  })
})
