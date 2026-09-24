import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── Mocks must be declared before any imports of the modules they replace ─────
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    collectiveWallet: { findUnique: vi.fn() },
    emergencyRecovery: { findFirst: vi.fn(), create: vi.fn() },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { POST, MIN_APPROVALS } from '../route'

// ── Typed mock handles ────────────────────────────────────────────────────────
const mockedVerify = vi.mocked(verifyAuthToken)
const userDelegate = prisma.user as unknown as { findUnique: ReturnType<typeof vi.fn> }
const walletDelegate = prisma.collectiveWallet as unknown as {
  findUnique: ReturnType<typeof vi.fn>
}
const recoveryDelegate = prisma.emergencyRecovery as unknown as {
  findFirst: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
}

// ── Fixture constants ─────────────────────────────────────────────────────────
const WALLET_ID = 'wallet-1'
const USER_ID = 'user-admin-1'
const PRIVY_ID = 'privy-admin-1'
const RECOVERY_ID = 'recovery-1'
const GOOD_JUSTIFICATION =
  'Three of our five signers are permanently unreachable after a hardware failure.'

const BASE_URL = 'http://localhost/api/wallet-signers/emergency-recovery'

// ── Fixture builders ──────────────────────────────────────────────────────────
function makeAdminUser(overrides: Record<string, unknown> = {}) {
  return { id: USER_ID, role: 'admin', ...overrides }
}

/**
 * Wallet with 1 active signer vs threshold 2 → quorum is broken.
 */
function makeBrokenWallet(overrides: Record<string, unknown> = {}) {
  return {
    id: WALLET_ID,
    threshold: 2,
    signers: [{ userId: 'signer-1' }], // only 1, need 2
    ...overrides,
  }
}

/**
 * Wallet with 2 active signers and threshold 2 → quorum is intact.
 */
function makeHealthyWallet() {
  return {
    id: WALLET_ID,
    threshold: 2,
    signers: [{ userId: 'signer-1' }, { userId: 'signer-2' }],
  }
}

function makeCreatedRecovery() {
  return {
    id: RECOVERY_ID,
    walletId: WALLET_ID,
    initiatorId: USER_ID,
    justification: GOOD_JUSTIFICATION,
    status: 'pending',
    signerCountAtRequest: 1,
    thresholdAtRequest: 2,
    activeSignerCount: 1,
    expiresAt: new Date(Date.now() + 72 * 3600 * 1000),
    createdAt: new Date(),
  }
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

// ── Test suite ────────────────────────────────────────────────────────────────
describe('POST /api/wallet-signers/emergency-recovery', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    // Happy-path defaults
    mockedVerify.mockResolvedValue({ userId: PRIVY_ID } as never)
    userDelegate.findUnique.mockResolvedValue(makeAdminUser())
    walletDelegate.findUnique.mockResolvedValue(makeBrokenWallet())
    recoveryDelegate.findFirst.mockResolvedValue(null) // no existing open request
    recoveryDelegate.create.mockResolvedValue(makeCreatedRecovery())
  })

  // ── Auth ────────────────────────────────────────────────────────────────────
  it('returns 401 when no Authorization header is present', async () => {
    const res = await makePost({ walletId: WALLET_ID, justification: GOOD_JUSTIFICATION }, null)
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Unauthorized')
  })

  it('returns 401 when the token fails verification', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await makePost({ walletId: WALLET_ID, justification: GOOD_JUSTIFICATION })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Invalid token')
  })

  it('returns 404 when the authenticated user does not exist in the database', async () => {
    userDelegate.findUnique.mockResolvedValue(null)
    const res = await makePost({ walletId: WALLET_ID, justification: GOOD_JUSTIFICATION })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('User not found')
  })

  // ── Admin gate ──────────────────────────────────────────────────────────────
  it('returns 403 when the user is not an admin', async () => {
    userDelegate.findUnique.mockResolvedValue(makeAdminUser({ role: 'freelancer' }))
    const res = await makePost({ walletId: WALLET_ID, justification: GOOD_JUSTIFICATION })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toMatch(/admin/)
  })

  // ── Input validation ────────────────────────────────────────────────────────
  it('returns 400 for invalid JSON body', async () => {
    const res = await POST(
      new NextRequest(BASE_URL, {
        method: 'POST',
        headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
        body: 'not-json',
      }),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Invalid JSON body')
  })

  it('returns 400 when walletId is missing', async () => {
    const res = await makePost({ justification: GOOD_JUSTIFICATION })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/walletId/)
  })

  it('returns 400 when walletId is an empty string', async () => {
    const res = await makePost({ walletId: '   ', justification: GOOD_JUSTIFICATION })
    expect(res.status).toBe(400)
  })

  it('returns 400 when justification is missing', async () => {
    const res = await makePost({ walletId: WALLET_ID })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/justification/)
  })

  it('returns 400 when justification is too short', async () => {
    const res = await makePost({ walletId: WALLET_ID, justification: 'too short' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/justification/)
  })

  // ── Wallet lookup ───────────────────────────────────────────────────────────
  it('returns 404 when the wallet does not exist', async () => {
    walletDelegate.findUnique.mockResolvedValue(null)
    const res = await makePost({ walletId: WALLET_ID, justification: GOOD_JUSTIFICATION })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('Wallet not found')
  })

  // ── Quorum check: reject if quorum is intact ────────────────────────────────
  it('returns 409 when the wallet quorum is not broken', async () => {
    walletDelegate.findUnique.mockResolvedValue(makeHealthyWallet())
    const res = await makePost({ walletId: WALLET_ID, justification: GOOD_JUSTIFICATION })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toMatch(/quorum is not broken/)
    expect(body.details.activeSignerCount).toBe(2)
    expect(body.details.threshold).toBe(2)
  })

  it('returns 409 when quorum is intact even with threshold=1', async () => {
    walletDelegate.findUnique.mockResolvedValue({
      id: WALLET_ID,
      threshold: 1,
      signers: [{ userId: 'signer-1' }], // 1 >= 1, quorum fine
    })
    const res = await makePost({ walletId: WALLET_ID, justification: GOOD_JUSTIFICATION })
    expect(res.status).toBe(409)
  })

  // ── Duplicate open request ──────────────────────────────────────────────────
  it('returns 409 when an active recovery request already exists for the wallet', async () => {
    recoveryDelegate.findFirst.mockResolvedValue({
      id: 'existing-recovery',
      status: 'pending',
    })
    const res = await makePost({ walletId: WALLET_ID, justification: GOOD_JUSTIFICATION })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toMatch(/already exists/)
    expect(body.existingRecoveryId).toBe('existing-recovery')
  })

  // ── Happy path ──────────────────────────────────────────────────────────────
  it('creates an emergency recovery record and returns 201', async () => {
    const res = await makePost({ walletId: WALLET_ID, justification: GOOD_JUSTIFICATION })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.recovery.id).toBe(RECOVERY_ID)
    expect(body.recovery.status).toBe('pending')
    expect(body.recovery.walletId).toBe(WALLET_ID)
  })

  it('response includes requiredApprovals equal to MIN_APPROVALS', async () => {
    const res = await makePost({ walletId: WALLET_ID, justification: GOOD_JUSTIFICATION })
    const body = await res.json()
    expect(body.recovery.requiredApprovals).toBe(MIN_APPROVALS)
    expect(body.recovery.approvalsReceived).toBe(0)
  })

  it('response includes the quorum snapshot fields', async () => {
    const res = await makePost({ walletId: WALLET_ID, justification: GOOD_JUSTIFICATION })
    const body = await res.json()
    expect(body.recovery.signerCountAtRequest).toBe(1)
    expect(body.recovery.thresholdAtRequest).toBe(2)
    expect(body.recovery.activeSignerCount).toBe(1)
  })

  it('response message mentions the required approval count', async () => {
    const res = await makePost({ walletId: WALLET_ID, justification: GOOD_JUSTIFICATION })
    const body = await res.json()
    expect(body.message).toMatch(new RegExp(String(MIN_APPROVALS)))
  })

  it('passes the correct data to prisma.emergencyRecovery.create', async () => {
    await makePost({ walletId: WALLET_ID, justification: GOOD_JUSTIFICATION })
    expect(recoveryDelegate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          walletId: WALLET_ID,
          initiatorId: USER_ID,
          justification: GOOD_JUSTIFICATION,
          status: 'pending',
          signerCountAtRequest: 1,
          thresholdAtRequest: 2,
          activeSignerCount: 1,
        }),
      }),
    )
  })

  it('trims whitespace from walletId and justification before storing', async () => {
    await makePost({
      walletId: `  ${WALLET_ID}  `,
      justification: `  ${GOOD_JUSTIFICATION}  `,
    })
    expect(walletDelegate.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: WALLET_ID } }),
    )
    expect(recoveryDelegate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          walletId: WALLET_ID,
          justification: GOOD_JUSTIFICATION,
        }),
      }),
    )
  })

  // ── Internal server error ───────────────────────────────────────────────────
  it('returns 500 when the database throws an unexpected error', async () => {
    recoveryDelegate.create.mockRejectedValue(new Error('connection lost'))
    const res = await makePost({ walletId: WALLET_ID, justification: GOOD_JUSTIFICATION })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Failed to initiate emergency recovery')
  })

  it('returns 500 when the wallet lookup throws', async () => {
    walletDelegate.findUnique.mockRejectedValue(new Error('db timeout'))
    const res = await makePost({ walletId: WALLET_ID, justification: GOOD_JUSTIFICATION })
    expect(res.status).toBe(500)
  })
})
