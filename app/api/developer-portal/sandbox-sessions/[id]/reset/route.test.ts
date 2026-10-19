import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { StrKey } from '@stellar/stellar-sdk'

vi.mock('@/lib/db', () => {
  const prisma: any = {
    user: { findUnique: vi.fn() },
    sandboxSession: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
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
const NOW = new Date('2026-10-18T12:00:00Z')
const FUTURE = new Date('2026-10-18T16:00:00Z')

function makeRequest(body?: unknown, raw?: string): NextRequest {
  return new NextRequest('http://localhost/api/developer-portal/sandbox-sessions/session-1/reset', {
    method: 'POST',
    headers: {
      authorization: 'Bearer token',
      'content-type': 'application/json',
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  })
}

function routeContext(id = 'session-1') {
  return { params: Promise.resolve({ id }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(actor as any)

  vi.mocked(prisma.sandboxSession.findUnique).mockResolvedValue({
    id: 'session-1',
    apiKeyId: 'key-1',
    userId: 'user-1',
    status: 'active',
    seed: 'custom-seed-123',
    seedData: { users: [], wallets: [], invoices: [] },
    resetCount: 2,
    lastResetAt: new Date('2026-10-18T10:00:00Z'),
    jobInFlight: false,
    activeJobId: null,
    expiresAt: FUTURE,
    createdAt: new Date('2026-10-18T09:00:00Z'),
    updatedAt: new Date('2026-10-18T10:00:00Z'),
  } as any)

  vi.mocked(prisma.sandboxSession.update).mockImplementation(
    (async (args: any) => ({
      id: args.where.id,
      apiKeyId: 'key-1',
      status: 'active',
      seed: args.data.seed,
      resetCount: 3,
      lastResetAt: NOW,
      expiresAt: FUTURE,
      createdAt: new Date('2026-10-18T09:00:00Z'),
      updatedAt: NOW,
    })) as any
  )
})

afterEach(() => {
  vi.useRealTimers()
})

describe('POST /api/developer-portal/sandbox-sessions/[id]/reset', () => {
  it('resets a sandbox session to the baseline dataset in a transaction and increments resetCount', async () => {
    const res = await POST(makeRequest(), routeContext('session-1'))

    expect(res.status).toBe(200)
    expect(prisma.$transaction).toHaveBeenCalled()
    expect(prisma.sandboxSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'session-1' },
        data: expect.objectContaining({
          resetCount: { increment: 1 },
          lastResetAt: NOW,
        }),
      })
    )

    const body = await res.json()
    expect(body.session.id).toBe('session-1')
    expect(body.resetCount).toBe(3)
    expect(body.data.users).toHaveLength(3)
    expect(body.data.wallets).toHaveLength(3)
    expect(body.data.invoices).toHaveLength(6)

    // Ensure session IDs are namespaced properly
    for (const wallet of body.data.wallets) {
      expect(wallet.id.startsWith('sbx_session-1_')).toBe(true)
      expect(StrKey.isValidEd25519PublicKey(wallet.address)).toBe(true)
    }
  })

  it('rejects reset requests when a job is currently in flight with 409 and retry guidance', async () => {
    vi.mocked(prisma.sandboxSession.findUnique).mockResolvedValue({
      id: 'session-1',
      apiKeyId: 'key-1',
      userId: 'user-1',
      status: 'active',
      seed: 'seed-1',
      jobInFlight: true,
      activeJobId: 'job_xyz_987',
      expiresAt: FUTURE,
    } as any)

    const res = await POST(makeRequest(), routeContext('session-1'))

    expect(res.status).toBe(409)
    expect(res.headers.get('Retry-After')).toBe('5')

    const body = await res.json()
    expect(body.code).toBe('SANDBOX_JOB_IN_FLIGHT')
    expect(body.retryAfterSeconds).toBe(5)
    expect(body.details.activeJobId).toBe('job_xyz_987')
    expect(prisma.sandboxSession.update).not.toHaveBeenCalled()
  })

  it('returns 404 if session is not found or belongs to another user', async () => {
    vi.mocked(prisma.sandboxSession.findUnique).mockResolvedValue(null)

    const res = await POST(makeRequest(), routeContext('non-existent'))
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe('SANDBOX_SESSION_NOT_FOUND')

    vi.mocked(prisma.sandboxSession.findUnique).mockResolvedValue({
      id: 'session-1',
      userId: 'different-user',
    } as any)

    const res2 = await POST(makeRequest(), routeContext('session-1'))
    expect(res2.status).toBe(404)
    expect(prisma.sandboxSession.update).not.toHaveBeenCalled()
  })

  it('returns 410 if the sandbox session is expired', async () => {
    vi.mocked(prisma.sandboxSession.findUnique).mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      status: 'expired',
      expiresAt: new Date(NOW.getTime() - 1000),
    } as any)

    const res = await POST(makeRequest(), routeContext('session-1'))
    expect(res.status).toBe(410)
    expect((await res.json()).code).toBe('SANDBOX_SESSION_EXPIRED')
    expect(prisma.sandboxSession.update).not.toHaveBeenCalled()
  })

  it('rejects invalid JSON body with 400', async () => {
    const res = await POST(makeRequest(undefined, '{bad-json'), routeContext('session-1'))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Invalid JSON body')
  })

  it('rejects invalid seed schema with 400', async () => {
    const res = await POST(makeRequest({ seed: '' }), routeContext('session-1'))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Invalid request body')
  })

  it('allows optional custom seed in body during reset', async () => {
    const res = await POST(makeRequest({ seed: 'new-custom-seed' }), routeContext('session-1'))
    expect(res.status).toBe(200)
    expect(prisma.sandboxSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          seed: 'new-custom-seed',
        }),
      })
    )
  })

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null as any)

    const res = await POST(makeRequest(), routeContext('session-1'))
    expect(res.status).toBe(401)
  })

  it('returns 500 when transaction or database fails', async () => {
    vi.mocked(prisma.sandboxSession.findUnique).mockRejectedValue(new Error('DB failure'))

    const res = await POST(makeRequest(), routeContext('session-1'))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('Failed to reset sandbox session')
  })
})
