import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── Mocks must be declared before importing the module under test ─────────────
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    structuringFlag: { findUnique: vi.fn(), update: vi.fn() },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { POST } from '../route'

// ── Typed mock handles ────────────────────────────────────────────────────────
const mockedVerify = vi.mocked(verifyAuthToken)
const userDelegate = prisma.user as unknown as { findUnique: ReturnType<typeof vi.fn> }
const flagDelegate = prisma.structuringFlag as unknown as {
  findUnique: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
}

// ── Fixtures ──────────────────────────────────────────────────────────────────
const FLAG_ID = 'flag-1'
const USER_ID = 'user-compliance-1'
const PRIVY_ID = 'privy-compliance-1'
const GOOD_REASON = 'Reviewed transaction history; payments are routine monthly transfers.'

const BASE_URL = `http://localhost/api/compliance/structuring-detection/${FLAG_ID}/dismiss`

function makeComplianceUser(overrides: Record<string, unknown> = {}) {
  return { id: USER_ID, role: 'compliance', ...overrides }
}

function makeOpenFlag(overrides: Record<string, unknown> = {}) {
  return {
    id: FLAG_ID,
    userId: 'subject-user-1',
    status: 'open',
    reason: 'Multiple sub-threshold deposits detected within 24-hour window.',
    dismissedById: null,
    dismissalReason: null,
    dismissedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

function makeDismissedFlag() {
  return {
    ...makeOpenFlag(),
    status: 'dismissed',
    dismissedById: USER_ID,
    dismissalReason: GOOD_REASON,
    dismissedAt: new Date(),
    updatedAt: new Date(),
  }
}

function makePost(id: string, body: unknown, authHeader: string | null = 'Bearer token') {
  return POST(
    new NextRequest(
      `http://localhost/api/compliance/structuring-detection/${id}/dismiss`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authHeader ? { authorization: authHeader } : {}),
        },
        body: JSON.stringify(body),
      },
    ),
    { params: { id } },
  )
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('POST /api/compliance/structuring-detection/[id]/dismiss', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedVerify.mockResolvedValue({ userId: PRIVY_ID } as never)
    userDelegate.findUnique.mockResolvedValue(makeComplianceUser())
    flagDelegate.findUnique.mockResolvedValue(makeOpenFlag())
    flagDelegate.update.mockResolvedValue(makeDismissedFlag())
  })

  // ── Auth ────────────────────────────────────────────────────────────────────
  it('returns 401 when no Authorization header is present', async () => {
    const res = await makePost(FLAG_ID, { reason: GOOD_REASON }, null)
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('Unauthorized')
  })

  it('returns 401 when the token fails verification', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await makePost(FLAG_ID, { reason: GOOD_REASON })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('Invalid token')
  })

  it('returns 404 when the authenticated user does not exist in the database', async () => {
    userDelegate.findUnique.mockResolvedValue(null)
    const res = await makePost(FLAG_ID, { reason: GOOD_REASON })
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('User not found')
  })

  // ── Role gate ───────────────────────────────────────────────────────────────
  it('returns 403 when the user role is freelancer', async () => {
    userDelegate.findUnique.mockResolvedValue(makeComplianceUser({ role: 'freelancer' }))
    const res = await makePost(FLAG_ID, { reason: GOOD_REASON })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/admin or compliance/)
  })

  it('allows access for role=admin', async () => {
    userDelegate.findUnique.mockResolvedValue(makeComplianceUser({ role: 'admin' }))
    const res = await makePost(FLAG_ID, { reason: GOOD_REASON })
    expect(res.status).toBe(200)
  })

  it('allows access for role=compliance', async () => {
    const res = await makePost(FLAG_ID, { reason: GOOD_REASON })
    expect(res.status).toBe(200)
  })

  // ── Input validation ────────────────────────────────────────────────────────
  it('returns 400 for malformed JSON body', async () => {
    const res = await POST(
      new NextRequest(BASE_URL, {
        method: 'POST',
        headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
        body: 'not-json',
      }),
      { params: { id: FLAG_ID } },
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Invalid JSON body')
  })

  it('returns 400 when reason is missing', async () => {
    const res = await makePost(FLAG_ID, {})
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/reason/)
  })

  it('returns 400 when reason is too short', async () => {
    const res = await makePost(FLAG_ID, { reason: 'too short' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/reason/)
  })

  it('returns 400 when reason is whitespace only', async () => {
    const res = await makePost(FLAG_ID, { reason: '          ' })
    expect(res.status).toBe(400)
  })

  // ── Flag lookup ─────────────────────────────────────────────────────────────
  it('returns 404 when the structuring flag does not exist', async () => {
    flagDelegate.findUnique.mockResolvedValue(null)
    const res = await makePost(FLAG_ID, { reason: GOOD_REASON })
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('Structuring flag not found')
  })

  // ── Escalated guard ─────────────────────────────────────────────────────────
  it('returns 409 when the flag has been escalated to a formal case', async () => {
    flagDelegate.findUnique.mockResolvedValue(makeOpenFlag({ status: 'escalated' }))
    const res = await makePost(FLAG_ID, { reason: GOOD_REASON })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toMatch(/escalated/)
    expect(body.currentStatus).toBe('escalated')
  })

  // ── Already-dismissed guard ─────────────────────────────────────────────────
  it('returns 409 when the flag is already dismissed', async () => {
    flagDelegate.findUnique.mockResolvedValue(makeOpenFlag({ status: 'dismissed' }))
    const res = await makePost(FLAG_ID, { reason: GOOD_REASON })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toMatch(/already been dismissed/)
    expect(body.currentStatus).toBe('dismissed')
  })

  // ── Happy path ──────────────────────────────────────────────────────────────
  it('returns 200 with a dismissed flag on the happy path', async () => {
    const res = await makePost(FLAG_ID, { reason: GOOD_REASON })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.flag.status).toBe('dismissed')
    expect(body.flag.id).toBe(FLAG_ID)
    expect(body.message).toMatch(/dismissed successfully/)
  })

  it('calls update with status=dismissed and correct fields', async () => {
    await makePost(FLAG_ID, { reason: GOOD_REASON })
    expect(flagDelegate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: FLAG_ID },
        data: expect.objectContaining({
          status: 'dismissed',
          dismissedById: USER_ID,
          dismissalReason: GOOD_REASON,
        }),
      }),
    )
  })

  it('trims whitespace from the reason before storing', async () => {
    await makePost(FLAG_ID, { reason: `  ${GOOD_REASON}  ` })
    expect(flagDelegate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ dismissalReason: GOOD_REASON }),
      }),
    )
  })

  it('response payload includes all expected fields', async () => {
    const res = await makePost(FLAG_ID, { reason: GOOD_REASON })
    const { flag } = await res.json()
    expect(flag).toHaveProperty('id')
    expect(flag).toHaveProperty('userId')
    expect(flag).toHaveProperty('status')
    expect(flag).toHaveProperty('reason')
    expect(flag).toHaveProperty('dismissalReason')
    expect(flag).toHaveProperty('dismissedById')
    expect(flag).toHaveProperty('dismissedAt')
    expect(flag).toHaveProperty('createdAt')
  })

  // ── Internal server error ───────────────────────────────────────────────────
  it('returns 500 when the database update throws', async () => {
    flagDelegate.update.mockRejectedValue(new Error('db timeout'))
    const res = await makePost(FLAG_ID, { reason: GOOD_REASON })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('Failed to dismiss structuring flag')
  })

  it('returns 500 when the flag lookup throws', async () => {
    flagDelegate.findUnique.mockRejectedValue(new Error('connection lost'))
    const res = await makePost(FLAG_ID, { reason: GOOD_REASON })
    expect(res.status).toBe(500)
  })
})
