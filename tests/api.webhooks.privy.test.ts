import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

const fundNewWallet = vi.fn()

vi.mock('@/lib/stellar-funding', () => ({ fundNewWallet }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn(), create: vi.fn() },
    wallet: { findUnique: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
  },
}))
vi.mock('@/lib/email', () => ({ sendAdminAlertEmail: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const SECRET = 'whsec_' + Buffer.from('super-secret-signing-key!!').toString('base64')
const URL = 'http://localhost/api/webhooks/privy'

function signPayload(rawBody: string, id = 'msg_123', timestamp = '1700000000') {
  const key = Buffer.from(SECRET.slice('whsec_'.length), 'base64')
  const signedContent = `${id}.${timestamp}.${rawBody}`
  const signature = crypto.createHmac('sha256', key).update(signedContent).digest('base64')
  return { id, timestamp, signature: `v1,${signature}` }
}

function makeRequest(rawBody: string, headers: Record<string, string> = {}) {
  return new NextRequest(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: rawBody,
  })
}

describe('POST /api/webhooks/privy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.PRIVY_WEBHOOK_SECRET = SECRET
  })

  it('rejects unsigned payloads before handler logic runs', async () => {
    const { POST } = await import('@/app/api/webhooks/privy/route')
    const rawBody = JSON.stringify({ type: 'user.created', data: { user: { id: 'privy-evil' } } })
    const res = await POST(makeRequest(rawBody))

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: 'Invalid signature' })
    expect(fundNewWallet).not.toHaveBeenCalled()
  })

  it('accepts a valid Svix signature', async () => {
    const { POST } = await import('@/app/api/webhooks/privy/route')
    const rawBody = JSON.stringify({ type: 'privy.test' })
    const { id, timestamp, signature } = signPayload(rawBody)

    const res = await POST(
      makeRequest(rawBody, {
        'svix-id': id,
        'svix-timestamp': timestamp,
        'svix-signature': signature,
      }),
    )

    expect(res.status).toBe(200)
    expect(fundNewWallet).not.toHaveBeenCalled()
  })
})
