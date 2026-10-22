import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { StrKey } from '@stellar/stellar-sdk'

vi.mock('@/lib/db', () => {
  const prisma: any = {
    user: { findUnique: vi.fn() },
    apiKey: { findFirst: vi.fn() },
    sandboxSession: { updateMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  }
  prisma.$transaction = vi.fn((fn: (tx: unknown) => unknown) => fn(prisma))
  return { prisma }
})
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

import { POST } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const actor = { id: 'user-1', email: 'dev@example.com' }
const NOW = new Date('2026-10-17T12:00:00Z')

function makeRequest(body?: unknown, raw?: string): NextRequest {
  return new NextRequest('http://localhost/api/developer-portal/sandbox-sessions', {
    method: 'POST',
    headers: { authorization: 'Bearer token' },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  })
}

function createArgs() {
  return vi.mocked(prisma.sandboxSession.create).mock.calls[0][0] as any
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(actor as any)
  vi.mocked(prisma.apiKey.findFirst).mockResolvedValue({ id: 'key-1', isActive: true, deactivatesAt: null } as any)
  vi.mocked(prisma.sandboxSession.updateMany).mockResolvedValue({ count: 0 })
  vi.mocked(prisma.sandboxSession.findFirst).mockResolvedValue(null)
  vi.mocked(prisma.sandboxSession.create).mockImplementation(
    (async (args: any) => ({
      id: args.data.id,
      apiKeyId: args.data.apiKeyId,
      status: args.data.status,
      seed: args.data.seed,
      expiresAt: args.data.expiresAt,
      createdAt: NOW,
    })) as any
  )
})

afterEach(() => {
  vi.useRealTimers()
})

describe('POST /api/developer-portal/sandbox-sessions', () => {
  it('creates an active session with seeded users, wallets and invoices scoped to the session id', async () => {
    const res = await POST(makeRequest({ apiKeyId: 'key-1' }))

    expect(res.status).toBe(201)
    const data = createArgs().data
    expect(data.apiKeyId).toBe('key-1')
    expect(data.userId).toBe('user-1')
    expect(data.status).toBe('active')
    expect(data.seed).toBe('lancepay-sandbox-v1')

    const body = await res.json()
    expect(body.session.id).toBe(data.id)
    expect(body.data.users).toHaveLength(3)
    expect(body.data.wallets).toHaveLength(3)
    expect(body.data.invoices).toHaveLength(6)

    const prefix = `sbx_${data.id}_`
    for (const record of [...body.data.users, ...body.data.wallets, ...body.data.invoices]) {
      expect(record.id.startsWith(prefix)).toBe(true)
    }
    for (const wallet of body.data.wallets) {
      expect(StrKey.isValidEd25519PublicKey(wallet.address)).toBe(true)
    }
    expect(data.seedData).toEqual(body.data)
  })

  it('attaches a default one hour TTL', async () => {
    await POST(makeRequest({ apiKeyId: 'key-1' }))
    expect(createArgs().data.expiresAt).toEqual(new Date(NOW.getTime() + 3600 * 1000))
  })

  it('honours a custom ttlSeconds', async () => {
    await POST(makeRequest({ apiKeyId: 'key-1', ttlSeconds: 900 }))
    expect(createArgs().data.expiresAt).toEqual(new Date(NOW.getTime() + 900 * 1000))
  })

  it.each([60, 86401, 120.5])('rejects ttlSeconds %s', async (ttlSeconds) => {
    const res = await POST(makeRequest({ apiKeyId: 'key-1', ttlSeconds }))
    expect(res.status).toBe(400)
    expect(prisma.sandboxSession.create).not.toHaveBeenCalled()
  })

  it('seeds the same dataset for the same seed across sessions', async () => {
    await POST(makeRequest({ apiKeyId: 'key-1', seed: 'demo' }))
    vi.mocked(prisma.sandboxSession.findFirst).mockResolvedValue(null)
    await POST(makeRequest({ apiKeyId: 'key-1', seed: 'demo' }))

    const [first, second] = vi.mocked(prisma.sandboxSession.create).mock.calls.map((c) => (c[0] as any).data)
    expect(first.id).not.toBe(second.id)
    const strip = (d: any) => JSON.parse(JSON.stringify(d.seedData).replaceAll(d.id, 'SESSION'))
    expect(strip(first)).toEqual(strip(second))
  })

  it('rejects a second active session for the same developer app', async () => {
    const expiresAt = new Date(NOW.getTime() + 600_000)
    vi.mocked(prisma.sandboxSession.findFirst).mockResolvedValue({ id: 'session-old', expiresAt } as any)

    const res = await POST(makeRequest({ apiKeyId: 'key-1' }))

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('SANDBOX_SESSION_ACTIVE')
    expect(body.details.sessionId).toBe('session-old')
    expect(prisma.sandboxSession.create).not.toHaveBeenCalled()
  })

  it('expires lapsed active sessions before checking for an active one', async () => {
    await POST(makeRequest({ apiKeyId: 'key-1' }))

    expect(prisma.sandboxSession.updateMany).toHaveBeenCalledWith({
      where: { apiKeyId: 'key-1', status: 'active', expiresAt: { lte: NOW } },
      data: { status: 'expired' },
    })
    const updateOrder = vi.mocked(prisma.sandboxSession.updateMany).mock.invocationCallOrder[0]
    const findOrder = vi.mocked(prisma.sandboxSession.findFirst).mock.invocationCallOrder[0]
    expect(updateOrder).toBeLessThan(findOrder)
  })

  it('maps a lost race on the active-session unique index to 409', async () => {
    vi.mocked(prisma.sandboxSession.create).mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }))

    const res = await POST(makeRequest({ apiKeyId: 'key-1' }))

    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('SANDBOX_SESSION_ACTIVE')
  })

  it("returns 404 for an unknown or another user's API key", async () => {
    vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(null)

    const res = await POST(makeRequest({ apiKeyId: 'key-x' }))

    expect(res.status).toBe(404)
    const args = vi.mocked(prisma.apiKey.findFirst).mock.calls[0][0] as any
    expect(args.where).toEqual({ id: 'key-x', userId: 'user-1' })
  })

  it('rejects inactive or scheduled-deactivated API keys', async () => {
    vi.mocked(prisma.apiKey.findFirst).mockResolvedValue({ id: 'key-1', isActive: false, deactivatesAt: null } as any)
    expect((await POST(makeRequest({ apiKeyId: 'key-1' }))).status).toBe(409)

    vi.mocked(prisma.apiKey.findFirst).mockResolvedValue({
      id: 'key-1',
      isActive: true,
      deactivatesAt: new Date(NOW.getTime() - 1),
    } as any)
    expect((await POST(makeRequest({ apiKeyId: 'key-1' }))).status).toBe(409)
    expect(prisma.sandboxSession.create).not.toHaveBeenCalled()
  })

  it('validates the body', async () => {
    expect((await POST(makeRequest({}))).status).toBe(400)
    expect((await POST(makeRequest(undefined, '{bad'))).status).toBe(400)
  })

  it('returns 401 without a valid token', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null as any)
    expect((await POST(makeRequest({ apiKeyId: 'key-1' }))).status).toBe(401)
  })

  it('returns 500 on unexpected errors', async () => {
    vi.mocked(prisma.sandboxSession.create).mockRejectedValue(new Error('db down'))
    expect((await POST(makeRequest({ apiKeyId: 'key-1' }))).status).toBe(500)
  })
})
