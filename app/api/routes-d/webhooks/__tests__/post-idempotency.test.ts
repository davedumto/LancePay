import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { clearIdempotencyStore } from '../../_lib/idempotency'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    userWebhook: { count: vi.fn(), create: vi.fn() },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedWebhookCount = vi.mocked(prisma.userWebhook.count)
const mockedWebhookCreate = vi.mocked(prisma.userWebhook.create)

const USER_ID = 'user-1'
const BASE_URL = 'http://localhost/api/routes-d/webhooks'

function makePOST(
  body: unknown,
  options: { idempotencyKey?: string } = {},
): NextRequest {
  const headers: Record<string, string> = {
    authorization: 'Bearer token',
    'content-type': 'application/json',
  }
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey

  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

describe('POST /api/routes-d/webhooks idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearIdempotencyStore()
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFind.mockResolvedValue({ id: USER_ID } as never)
    mockedWebhookCount.mockResolvedValue(0 as never)
    mockedWebhookCreate.mockResolvedValue({
      id: 'wh-new',
      targetUrl: 'https://example.com/webhook',
      description: null,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    } as never)
  })

  it('returns the prior result when the same idempotency-key is reused', async () => {
    const { POST } = await import('../route')
    const body = { targetUrl: 'https://example.com/wh' }

    const first = await POST(makePOST(body, { idempotencyKey: 'idem-1' }))
    const second = await POST(makePOST(body, { idempotencyKey: 'idem-1' }))

    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(await second.json()).toEqual(await first.json())
    expect(mockedWebhookCreate).toHaveBeenCalledTimes(1)
  })

  it('returns 409 when the same idempotency-key is reused with a different body', async () => {
    const { POST } = await import('../route')

    await POST(makePOST({ targetUrl: 'https://example.com/wh-a' }, { idempotencyKey: 'idem-2' }))
    const conflict = await POST(
      makePOST({ targetUrl: 'https://example.com/wh-b' }, { idempotencyKey: 'idem-2' }),
    )

    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: 'Idempotency conflict' })
    expect(mockedWebhookCreate).toHaveBeenCalledTimes(1)
  })
})
