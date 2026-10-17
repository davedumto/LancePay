import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PATCH, DELETE } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    userWebhook: { findUnique: vi.fn(), update: vi.fn(), delete: vi.fn() },
    webhookDelivery: { deleteMany: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUser = { id: 'user-1', role: 'freelancer', email: 'user@test.com' }
const mockClaims = { userId: 'privy-1' }
const SECRET = 'super-secret-signing-key-never-exposed'
const mockWebhook = {
  id: 'wh-1',
  userId: 'user-1',
  targetUrl: 'https://merchant.example.com/webhooks',
  signingSecret: SECRET,
  previousSigningSecret: null,
  signingSecretExpiresAt: null,
  description: 'Initial webhook',
  isActive: true,
  subscribedEvents: ['invoice.paid'],
  status: 'ACTIVE',
  consecutiveFailures: 0,
  lastTriggeredAt: null,
  lastFailureAt: null,
  createdAt: new Date('2026-09-24T10:00:00Z'),
}

function makeRequest(
  method: 'PATCH' | 'DELETE',
  body?: unknown,
  token: string | null = 'valid-token',
): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest('http://localhost/api/user-webhooks/wh-1', {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const params = { params: Promise.resolve({ id: 'wh-1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
  vi.mocked(prisma.userWebhook.findUnique).mockResolvedValue(mockWebhook as any)
  vi.mocked(prisma.userWebhook.update).mockImplementation(async (args: any) => ({
    ...mockWebhook,
    ...args.data,
  }))
  vi.mocked(prisma.userWebhook.delete).mockResolvedValue(mockWebhook as any)
  vi.mocked(prisma.webhookDelivery.deleteMany).mockResolvedValue({ count: 3 } as any)
})

describe('PATCH /api/user-webhooks/[id]', () => {
  it('updates targetUrl, subscribedEvents, isActive, and description without exposing signingSecret', async () => {
    const res = await PATCH(
      makeRequest('PATCH', {
        targetUrl: 'https://new.example.com/hook',
        subscribedEvents: ['invoice.paid', 'withdrawal.completed'],
        isActive: false,
        description: 'Updated description',
      }),
      params,
    )
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.targetUrl).toBe('https://new.example.com/hook')
    expect(data.subscribedEvents).toEqual(['invoice.paid', 'withdrawal.completed'])
    expect(data.isActive).toBe(false)
    expect(data.status).toBe('INACTIVE')
    expect(data.description).toBe('Updated description')
    expect(data.signingSecret).toBeUndefined()
    expect(JSON.stringify(data)).not.toContain(SECRET)
  })

  it('resets consecutiveFailures and sets status=ACTIVE when re-enabling a webhook', async () => {
    vi.mocked(prisma.userWebhook.findUnique).mockResolvedValue({
      ...mockWebhook,
      isActive: false,
      status: 'INACTIVE',
      consecutiveFailures: 10,
    } as any)

    const res = await PATCH(makeRequest('PATCH', { isActive: true }), params)
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.isActive).toBe(true)
    expect(data.status).toBe('ACTIVE')
    expect(data.consecutiveFailures).toBe(0)
    expect(prisma.userWebhook.update).toHaveBeenCalledWith({
      where: { id: 'wh-1' },
      data: {
        isActive: true,
        status: 'ACTIVE',
        consecutiveFailures: 0,
      },
    })
  })

  it('rejects attempts to overwrite signingSecret or rotation fields directly (400)', async () => {
    const res1 = await PATCH(
      makeRequest('PATCH', { signingSecret: 'attacker-controlled-secret' }),
      params,
    )
    expect(res1.status).toBe(400)
    expect(prisma.userWebhook.update).not.toHaveBeenCalled()

    const res2 = await PATCH(
      makeRequest('PATCH', { previousSigningSecret: 'old' }),
      params,
    )
    expect(res2.status).toBe(400)
    expect(prisma.userWebhook.update).not.toHaveBeenCalled()
  })

  it('rejects invalid targetUrl, invalid subscribedEvents, or empty update body (400)', async () => {
    const badUrl = await PATCH(
      makeRequest('PATCH', { targetUrl: 'ftp://invalid.example.com' }),
      params,
    )
    expect(badUrl.status).toBe(400)

    const emptyEvents = await PATCH(
      makeRequest('PATCH', { subscribedEvents: [] }),
      params,
    )
    expect(emptyEvents.status).toBe(400)

    const unknownEvent = await PATCH(
      makeRequest('PATCH', { subscribedEvents: ['not.an.event'] }),
      params,
    )
    expect(unknownEvent.status).toBe(400)

    const emptyBody = await PATCH(makeRequest('PATCH', {}), params)
    expect(emptyBody.status).toBe(400)
  })

  it('forbids updating a webhook owned by another user (403)', async () => {
    vi.mocked(prisma.userWebhook.findUnique).mockResolvedValue({
      ...mockWebhook,
      userId: 'other-user',
    } as any)

    const res = await PATCH(
      makeRequest('PATCH', { targetUrl: 'https://new.example.com/hook' }),
      params,
    )
    expect(res.status).toBe(403)
    expect(prisma.userWebhook.update).not.toHaveBeenCalled()
  })

  it('returns 404 when webhook does not exist', async () => {
    vi.mocked(prisma.userWebhook.findUnique).mockResolvedValue(null)
    const res = await PATCH(
      makeRequest('PATCH', { targetUrl: 'https://new.example.com/hook' }),
      params,
    )
    expect(res.status).toBe(404)
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await PATCH(
      makeRequest('PATCH', { targetUrl: 'https://new.example.com/hook' }, null),
      params,
    )
    expect(res.status).toBe(401)
  })
})

describe('DELETE /api/user-webhooks/[id]', () => {
  it('deletes the webhook subscription and cleans up deliveries for the owner', async () => {
    const res = await DELETE(makeRequest('DELETE'), params)
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data).toMatchObject({ id: 'wh-1', deleted: true, removed: true })
    expect(prisma.webhookDelivery.deleteMany).toHaveBeenCalledWith({
      where: { webhookId: 'wh-1' },
    })
    expect(prisma.userWebhook.delete).toHaveBeenCalledWith({
      where: { id: 'wh-1' },
    })
  })

  it('forbids deleting a webhook owned by another user (403)', async () => {
    vi.mocked(prisma.userWebhook.findUnique).mockResolvedValue({
      ...mockWebhook,
      userId: 'other-user',
    } as any)

    const res = await DELETE(makeRequest('DELETE'), params)
    expect(res.status).toBe(403)
    expect(prisma.userWebhook.delete).not.toHaveBeenCalled()
  })

  it('returns 404 when the webhook does not exist', async () => {
    vi.mocked(prisma.userWebhook.findUnique).mockResolvedValue(null)
    const res = await DELETE(makeRequest('DELETE'), params)
    expect(res.status).toBe(404)
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await DELETE(makeRequest('DELETE', undefined, null), params)
    expect(res.status).toBe(401)
  })
})
