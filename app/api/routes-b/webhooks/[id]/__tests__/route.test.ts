import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GET, DELETE } from '../route'
import { buildRequest, makeUser } from '../../../_lib/test-helpers'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    userWebhook: {
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
  },
}))

vi.mock('../../../_lib/webhook-custom-headers', () => ({
  clearCustomHeaders: vi.fn(),
  getCustomHeaders: vi.fn().mockReturnValue({}),
  setCustomHeaders: vi.fn(),
  validateCustomHeaders: vi.fn(),
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { clearCustomHeaders } from '../../../_lib/webhook-custom-headers'

const mockedVerifyAuthToken = vi.mocked(verifyAuthToken)
const mockedUserFindUnique = vi.mocked(prisma.user.findUnique)
const mockedWebhookFindUnique = vi.mocked(prisma.userWebhook.findUnique)
const mockedWebhookDelete = vi.mocked(prisma.userWebhook.delete)
const mockedClearCustomHeaders = vi.mocked(clearCustomHeaders)

const makeWebhook = (overrides = {}) => ({
  id: 'wh-1',
  userId: 'user-1',
  targetUrl: 'https://example.com/hook',
  description: 'Test Webhook',
  subscribedEvents: ['invoice.created'],
  isActive: true,
  signingSecret: 'secret_123',
  createdAt: new Date().toISOString(),
  ...overrides
})

describe('GET /api/routes-b/webhooks/[id]', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedVerifyAuthToken.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFindUnique.mockResolvedValue(makeUser({ id: 'user-1' }) as never)
  })

  it('returns 404 when webhook is not found', async () => {
    mockedWebhookFindUnique.mockResolvedValue(null as never)
    const request = buildRequest('GET', 'http://localhost/api/routes-b/webhooks/wh-1', { token: 'token' })
    const response = await GET(request, { params: Promise.resolve({ id: 'wh-1' }) } as any)
    const body = await response.json()

    expect(response.status).toBe(404)
    expect(body).toEqual({ error: 'Webhook not found' })
  })

  it('returns webhook details when found', async () => {
    mockedWebhookFindUnique.mockResolvedValue(makeWebhook() as never)
    
    const request = buildRequest('GET', 'http://localhost/api/routes-b/webhooks/wh-1', { token: 'token' })
    const response = await GET(request, { params: Promise.resolve({ id: 'wh-1' }) } as any)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.webhook.id).toBe('wh-1')
    expect(body.webhook.targetUrl).toBe('https://example.com/hook')
    expect(body.webhook.isActive).toBe(true)
  })
})

describe('DELETE /api/routes-b/webhooks/[id]', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedVerifyAuthToken.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFindUnique.mockResolvedValue(makeUser({ id: 'user-1' }) as never)
  })

  it('returns 404 when webhook to delete is not found', async () => {
    mockedWebhookFindUnique.mockResolvedValue(null as never)
    const request = buildRequest('DELETE', 'http://localhost/api/routes-b/webhooks/wh-1', { token: 'token' })
    const response = await DELETE(request, { params: Promise.resolve({ id: 'wh-1' }) } as any)
    const body = await response.json()

    expect(response.status).toBe(404)
    expect(body).toEqual({ error: 'Webhook not found' })
    expect(mockedWebhookDelete).not.toHaveBeenCalled()
  })

  it('deletes webhook and clears headers when successful', async () => {
    mockedWebhookFindUnique.mockResolvedValue(makeWebhook() as never)
    
    const request = buildRequest('DELETE', 'http://localhost/api/routes-b/webhooks/wh-1', { token: 'token' })
    const response = await DELETE(request, { params: Promise.resolve({ id: 'wh-1' }) } as any)

    expect(response.status).toBe(204)
    expect(mockedWebhookDelete).toHaveBeenCalledWith({ where: { id: 'wh-1' } })
    expect(mockedClearCustomHeaders).toHaveBeenCalledWith('wh-1')
  })
})
