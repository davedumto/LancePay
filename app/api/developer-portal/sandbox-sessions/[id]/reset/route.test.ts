import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => {
  const prisma: any = {
    user: { findUnique: vi.fn() },
    sandboxSession: {
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    distributedJobLock: {
      findFirst: vi.fn(),
    },
    sandboxJob: {
      count: vi.fn(),
      deleteMany: vi.fn(),
    },
  }
  prisma.$transaction = vi.fn((fn: (tx: unknown) => unknown) => fn(prisma))
  return { prisma }
})
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}))

import { POST, SANDBOX_JOB_RETRY_AFTER_SECONDS } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { DEFAULT_SANDBOX_SEED, generateSandboxDataset } from '@/lib/sandbox-seed'

const actor = { id: 'user-1', email: 'dev@lancepay.io' }
const NOW = new Date('2026-10-17T12:00:00.000Z')
const SESSION_ID = 'sbx-session-1234'

function makeRequest(body?: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/developer-portal/sandbox-sessions/${SESSION_ID}/reset`,
    {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }
  )
}

describe('POST /api/developer-portal/sandbox-sessions/[id]/reset (#1569)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)

    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue(actor as any)
    vi.mocked((prisma as any).distributedJobLock.findFirst).mockResolvedValue(null)
    vi.mocked((prisma as any).sandboxJob.count).mockResolvedValue(0)
    vi.mocked((prisma as any).sandboxJob.deleteMany).mockResolvedValue({ count: 0 })

    vi.mocked(prisma.sandboxSession.findFirst).mockResolvedValue({
      id: SESSION_ID,
      apiKeyId: 'key-1',
      userId: 'user-1',
      status: 'active',
      seed: DEFAULT_SANDBOX_SEED,
      seedData: {
        users: [], // Dirty/mutated state
        wallets: [],
        invoices: [],
        _meta: { resetCount: 2, lastResetAt: '2026-10-17T11:00:00.000Z' },
      },
      expiresAt: new Date(NOW.getTime() + 3600 * 1000),
      createdAt: new Date(NOW.getTime() - 1800 * 1000),
    } as any)

    vi.mocked(prisma.sandboxSession.update).mockImplementation(
      (async (args: any) => ({
        id: SESSION_ID,
        apiKeyId: 'key-1',
        status: 'active',
        seed: args.data.seed,
        seedData: args.data.seedData,
        expiresAt: new Date(NOW.getTime() + 3600 * 1000),
        createdAt: new Date(NOW.getTime() - 1800 * 1000),
      })) as any
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resets the sandbox session to the clean seeded baseline inside prisma.$transaction while preserving session id and bumping resetCount/lastResetAt', async () => {
    const res = await POST(makeRequest(), { params: { id: SESSION_ID } })

    expect(res.status).toBe(200)
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)

    const body = await res.json()
    expect(body.session.id).toBe(SESSION_ID)
    expect(body.session.resetCount).toBe(3)
    expect(body.session.lastResetAt).toBe(NOW.toISOString())

    const expectedBaseline = generateSandboxDataset(SESSION_ID, DEFAULT_SANDBOX_SEED)
    expect(body.data).toEqual(expectedBaseline)
    expect(body.data.users).toHaveLength(3)
    expect(body.data.wallets).toHaveLength(3)
    expect(body.data.invoices).toHaveLength(6)
  })

  it('rejects reset requests with HTTP 409 Conflict and Retry-After header when a sandbox job is in-flight', async () => {
    vi.mocked((prisma as any).sandboxJob.count).mockResolvedValueOnce(1)

    const res = await POST(makeRequest(), { params: { id: SESSION_ID } })

    expect(res.status).toBe(409)
    expect(res.headers.get('Retry-After')).toBe(String(SANDBOX_JOB_RETRY_AFTER_SECONDS))
    const body = await res.json()
    expect(body.code).toBe('SANDBOX_JOB_IN_FLIGHT')
    expect(prisma.sandboxSession.update).not.toHaveBeenCalled()
  })

  it('also rejects reset when distributedJobLock indicates an active in-flight sandbox job', async () => {
    vi.mocked((prisma as any).distributedJobLock.findFirst).mockResolvedValueOnce({
      id: 'lock-1',
      jobName: `sandbox:${SESSION_ID}`,
      expiresAt: new Date(NOW.getTime() + 10_000),
    } as any)

    const res = await POST(makeRequest(), { params: { id: SESSION_ID } })
    expect(res.status).toBe(409)
    expect(res.headers.get('Retry-After')).toBe(String(SANDBOX_JOB_RETRY_AFTER_SECONDS))
    expect(prisma.sandboxSession.update).not.toHaveBeenCalled()
  })

  it('rejects reset on expired sessions with 409, non-owner with 403, and missing session with 404', async () => {
    vi.mocked(prisma.sandboxSession.findFirst).mockResolvedValueOnce({
      id: SESSION_ID,
      userId: 'user-1',
      status: 'active',
      expiresAt: new Date(NOW.getTime() - 1000), // Expired
    } as any)
    const expiredRes = await POST(makeRequest(), { params: { id: SESSION_ID } })
    expect(expiredRes.status).toBe(409)
    expect((await expiredRes.json()).code).toBe('SANDBOX_SESSION_EXPIRED')

    vi.mocked(prisma.sandboxSession.findFirst).mockResolvedValueOnce({
      id: SESSION_ID,
      userId: 'other-user-2',
      status: 'active',
      expiresAt: new Date(NOW.getTime() + 60_000),
    } as any)
    const forbiddenRes = await POST(makeRequest(), { params: { id: SESSION_ID } })
    expect(forbiddenRes.status).toBe(403)

    vi.mocked(prisma.sandboxSession.findFirst).mockResolvedValueOnce(null)
    const notFoundRes = await POST(makeRequest(), { params: { id: 'missing-id' } })
    expect(notFoundRes.status).toBe(404)
  })
})
