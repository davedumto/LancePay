import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET, POST } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    userWebhook: { findMany: vi.fn(), create: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUser = { id: 'user-1', role: 'freelancer', email: 'user@test.com' }
const mockClaims = { userId: 'privy-1' }

function makeRequest(
  method: 'GET' | 'POST',
  body?: unknown,
  token: string | null = 'valid-token',
): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest('http://localhost/api/user-webhooks', {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
  vi.mocked(prisma.userWebhook.create).mockImplementation(async (args: any) => ({
    id: 'wh-created-1',
    createdAt: new Date('2026-09-24T12:00:00Z'),
    ...args.data,
  }))
})

describe('POST /api/user-webhooks', () => {
  it('creates a UserWebhook with a CSPRNG signingSecret and returns it once (201)', async () => {
    const res = await POST(
      makeRequest('POST', {
        targetUrl: 'https://merchant.example.com/webhooks/lancepay',
        subscribedEvents: ['invoice.paid', 'withdrawal.completed'],
        description: 'Production ERP webhook',
      }),
    )
    const data = await res.json()

    expect(res.status).toBe(201)
    expect(data.id).toBe('wh-created-1')
    expect(data.targetUrl).toBe('https://merchant.example.com/webhooks/lancepay')
    expect(data.subscribedEvents).toEqual(['invoice.paid', 'withdrawal.completed'])
    expect(data.description).toBe('Production ERP webhook')
    expect(data.isActive).toBe(true)
    expect(data.status).toBe('ACTIVE')
    expect(typeof data.signingSecret).toBe('string')
    expect(data.signingSecret).toMatch(/^[0-9a-f]{64}$/)

    expect(prisma.userWebhook.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        targetUrl: 'https://merchant.example.com/webhooks/lancepay',
        description: 'Production ERP webhook',
        subscribedEvents: ['invoice.paid', 'withdrawal.completed'],
        signingSecret: data.signingSecret,
        isActive: true,
        status: 'ACTIVE',
      },
    })
  })

  it('defaults subscribedEvents to ["invoice.paid"] when omitted', async () => {
    const res = await POST(
      makeRequest('POST', { targetUrl: 'https://merchant.example.com/webhooks' }),
    )
    const data = await res.json()

    expect(res.status).toBe(201)
    expect(data.subscribedEvents).toEqual(['invoice.paid'])
  })

  it('returns 400 when targetUrl is missing, malformed, or uses an invalid protocol', async () => {
    const resMissing = await POST(makeRequest('POST', {}))
    expect(resMissing.status).toBe(400)

    const resMalformed = await POST(makeRequest('POST', { targetUrl: 'not-a-valid-url' }))
    expect(resMalformed.status).toBe(400)

    const resBadProtocol = await POST(
      makeRequest('POST', { targetUrl: 'ftp://files.example.com/hook' }),
    )
    expect(resBadProtocol.status).toBe(400)

    expect(prisma.userWebhook.create).not.toHaveBeenCalled()
  })

  it('returns 400 when subscribedEvents is empty or contains unknown event types', async () => {
    const resEmpty = await POST(
      makeRequest('POST', {
        targetUrl: 'https://merchant.example.com/webhooks',
        subscribedEvents: [],
      }),
    )
    expect(resEmpty.status).toBe(400)

    const resUnknown = await POST(
      makeRequest('POST', {
        targetUrl: 'https://merchant.example.com/webhooks',
        subscribedEvents: ['invoice.paid', 'bogus.event'],
      }),
    )
    expect(resUnknown.status).toBe(400)

    expect(prisma.userWebhook.create).not.toHaveBeenCalled()
  })

  it('returns 400 when description exceeds 100 characters', async () => {
    const res = await POST(
      makeRequest('POST', {
        targetUrl: 'https://merchant.example.com/webhooks',
        description: 'x'.repeat(101),
      }),
    )
    expect(res.status).toBe(400)
  })

  it('returns 401 when unauthenticated or token is invalid', async () => {
    const resNoHeader = await POST(
      makeRequest('POST', { targetUrl: 'https://merchant.example.com/webhooks' }, null),
    )
    expect(resNoHeader.status).toBe(401)

    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const resBadToken = await POST(
      makeRequest('POST', { targetUrl: 'https://merchant.example.com/webhooks' }),
    )
    expect(resBadToken.status).toBe(401)
  })

  it('returns 404 when user is not found', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    const res = await POST(
      makeRequest('POST', { targetUrl: 'https://merchant.example.com/webhooks' }),
    )
    expect(res.status).toBe(404)
  })
})

describe('GET /api/user-webhooks', () => {
  it('lists user webhooks without ever returning signingSecret or previousSigningSecret', async () => {
    vi.mocked(prisma.userWebhook.findMany).mockResolvedValue([
      {
        id: 'wh-1',
        userId: 'user-1',
        targetUrl: 'https://merchant.example.com/webhooks',
        signingSecret: 'stored-secret-must-not-leak',
        previousSigningSecret: 'previous-secret-must-not-leak',
        description: 'Primary',
        isActive: true,
        subscribedEvents: ['invoice.paid'],
        status: 'ACTIVE',
        consecutiveFailures: 0,
        lastTriggeredAt: null,
        lastFailureAt: null,
        createdAt: new Date('2026-09-24T12:00:00Z'),
      },
    ] as any)

    const res = await GET(makeRequest('GET'))
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.webhooks).toHaveLength(1)
    expect(data.webhooks[0].signingSecret).toBeUndefined()
    expect(data.webhooks[0].previousSigningSecret).toBeUndefined()
    expect(JSON.stringify(data)).not.toContain('stored-secret-must-not-leak')
    expect(JSON.stringify(data)).not.toContain('previous-secret-must-not-leak')
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await GET(makeRequest('GET', undefined, null))
    expect(res.status).toBe(401)
  })
})
