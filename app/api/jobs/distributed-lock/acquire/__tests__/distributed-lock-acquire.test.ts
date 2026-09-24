import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── Mocks before imports ──────────────────────────────────────────────────────
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    distributedLock: { findUnique: vi.fn() },
    $executeRaw: vi.fn(),
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('crypto', () => ({ randomUUID: vi.fn(() => 'test-token-uuid') }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { POST } from '../route'

// ── Typed mock handles ────────────────────────────────────────────────────────
const mockedVerify = vi.mocked(verifyAuthToken)
const userDelegate = prisma.user as unknown as { findUnique: ReturnType<typeof vi.fn> }
const lockDelegate = prisma.distributedLock as unknown as { findUnique: ReturnType<typeof vi.fn> }
const executeRaw = prisma.$executeRaw as unknown as ReturnType<typeof vi.fn>

// ── Fixtures ──────────────────────────────────────────────────────────────────
const USER_ID = 'user-job-runner-1'
const PRIVY_ID = 'privy-job-1'
const LOCK_KEY = 'cancel-overdue-invoices'
const BASE_URL = 'http://localhost/api/jobs/distributed-lock/acquire'

function makeUser(overrides: Record<string, unknown> = {}) {
  return { id: USER_ID, role: 'admin', ...overrides }
}

function makePost(body: unknown, authHeader: string | null = 'Bearer token') {
  return POST(
    new NextRequest(BASE_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authHeader ? { authorization: authHeader } : {}),
      },
      body: JSON.stringify(body),
    }),
  )
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('POST /api/jobs/distributed-lock/acquire', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedVerify.mockResolvedValue({ userId: PRIVY_ID } as never)
    userDelegate.findUnique.mockResolvedValue(makeUser())
    // Default: lock successfully acquired (1 row affected)
    executeRaw.mockResolvedValue(1)
    lockDelegate.findUnique.mockResolvedValue(null)
  })

  // ── Auth ────────────────────────────────────────────────────────────────────
  it('returns 401 when no Authorization header is present', async () => {
    const res = await makePost({ key: LOCK_KEY }, null)
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('Unauthorized')
  })

  it('returns 401 when the token fails verification', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await makePost({ key: LOCK_KEY })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('Invalid token')
  })

  it('returns 404 when the authenticated user does not exist', async () => {
    userDelegate.findUnique.mockResolvedValue(null)
    const res = await makePost({ key: LOCK_KEY })
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('User not found')
  })

  // ── Input validation ────────────────────────────────────────────────────────
  it('returns 400 for malformed JSON body', async () => {
    const res = await POST(
      new NextRequest(BASE_URL, {
        method: 'POST',
        headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
        body: 'not-json',
      }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Invalid JSON body')
  })

  it('returns 400 when key is missing', async () => {
    const res = await makePost({})
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/key/)
  })

  it('returns 400 when key is empty string', async () => {
    const res = await makePost({ key: '   ' })
    expect(res.status).toBe(400)
  })

  it('returns 400 when ttlSeconds is not an integer', async () => {
    const res = await makePost({ key: LOCK_KEY, ttlSeconds: 1.5 })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/ttlSeconds/)
  })

  it('returns 400 when ttlSeconds is below minimum', async () => {
    const res = await makePost({ key: LOCK_KEY, ttlSeconds: 1 })
    expect(res.status).toBe(400)
  })

  it('returns 400 when ttlSeconds exceeds maximum', async () => {
    const res = await makePost({ key: LOCK_KEY, ttlSeconds: 9999 })
    expect(res.status).toBe(400)
  })

  // ── Lock already held (conflict) ────────────────────────────────────────────
  it('returns 409 with clear conflict message when lock is already held', async () => {
    executeRaw.mockResolvedValue(0)
    const futureExpiry = new Date(Date.now() + 60_000)
    lockDelegate.findUnique.mockResolvedValue({
      key: LOCK_KEY,
      holder: 'pod-1',
      expiresAt: futureExpiry,
    })

    const res = await makePost({ key: LOCK_KEY })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('Lock is already held')
    expect(body.key).toBe(LOCK_KEY)
    expect(body.holder).toBe('pod-1')
    expect(body.expiresAt).toBeTruthy()
  })

  it('returns 409 even when current lock row cannot be fetched', async () => {
    executeRaw.mockResolvedValue(0)
    lockDelegate.findUnique.mockResolvedValue(null)

    const res = await makePost({ key: LOCK_KEY })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.holder).toBeNull()
    expect(body.expiresAt).toBeNull()
  })

  // ── Happy path ──────────────────────────────────────────────────────────────
  it('returns 201 with lock details when acquired', async () => {
    const res = await makePost({ key: LOCK_KEY })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.lock.key).toBe(LOCK_KEY)
    expect(body.lock.token).toBe('test-token-uuid')
    expect(body.message).toBe('Lock acquired')
  })

  it('response includes acquiredAt, expiresAt, and ttlSeconds', async () => {
    const res = await makePost({ key: LOCK_KEY, ttlSeconds: 60 })
    const { lock } = await res.json()
    expect(lock.ttlSeconds).toBe(60)
    expect(lock.acquiredAt).toBeTruthy()
    expect(lock.expiresAt).toBeTruthy()
  })

  it('uses DEFAULT_TTL_SECONDS when ttlSeconds is not provided', async () => {
    const res = await makePost({ key: LOCK_KEY })
    const { lock } = await res.json()
    expect(lock.ttlSeconds).toBe(300)
  })

  it('includes holder in response when provided', async () => {
    const res = await makePost({ key: LOCK_KEY, holder: 'worker-pod-3' })
    const { lock } = await res.json()
    expect(lock.holder).toBe('worker-pod-3')
  })

  it('trims whitespace from key before using it', async () => {
    const res = await makePost({ key: `  ${LOCK_KEY}  ` })
    expect(res.status).toBe(201)
    const { lock } = await res.json()
    expect(lock.key).toBe(LOCK_KEY)
  })

  it('executes the atomic conditional raw SQL statement', async () => {
    await makePost({ key: LOCK_KEY })
    expect(executeRaw).toHaveBeenCalledTimes(1)
  })

  // ── Internal server error ───────────────────────────────────────────────────
  it('returns 500 when the raw SQL statement throws', async () => {
    executeRaw.mockRejectedValue(new Error('db connection lost'))
    const res = await makePost({ key: LOCK_KEY })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('Failed to acquire lock')
  })

  it('returns 500 when the conflict lookup throws', async () => {
    executeRaw.mockResolvedValue(0)
    lockDelegate.findUnique.mockRejectedValue(new Error('timeout'))
    const res = await makePost({ key: LOCK_KEY })
    expect(res.status).toBe(500)
  })
})
