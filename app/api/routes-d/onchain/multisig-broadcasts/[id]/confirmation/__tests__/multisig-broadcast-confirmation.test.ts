import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    multisigBroadcast: { findUnique: vi.fn() },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET } from '../route'

// ── typed mock handles ────────────────────────────────────────────────────────
const mockedVerify = vi.mocked(verifyAuthToken)
const userDelegate = prisma.user as unknown as { findUnique: ReturnType<typeof vi.fn> }
const broadcastDelegate = prisma.multisigBroadcast as unknown as {
  findUnique: ReturnType<typeof vi.fn>
}

const BASE_URL =
  'http://localhost/api/routes-d/onchain/multisig-broadcasts'

// ── fixture helpers ───────────────────────────────────────────────────────────
const BROADCAST_ID = 'broadcast-1'
const PROPOSAL_ID = 'proposal-1'
const WALLET_ID = 'wallet-1'
const USER_ID = 'user-1'
const OTHER_USER_ID = 'user-other'
const PRIVY_ID = 'privy-1'

/** Minimal broadcast row with a signer-only relationship */
function makeBroadcast(overrides: Record<string, unknown> = {}) {
  return {
    id: BROADCAST_ID,
    proposalId: PROPOSAL_ID,
    txHash: '0xdeadbeef',
    network: 'stellar',
    status: 'pending',
    broadcastAt: new Date('2026-01-01T00:00:00.000Z'),
    confirmedAt: null,
    failureReason: null,
    proposal: {
      id: PROPOSAL_ID,
      walletId: WALLET_ID,
      proposerId: OTHER_USER_ID, // user is signer, not proposer
      wallet: {
        signers: [{ userId: USER_ID }],
      },
    },
    ...overrides,
  }
}

function makeGet(id: string, authHeader: string | null = 'Bearer token') {
  return GET(
    new NextRequest(`${BASE_URL}/${id}/confirmation`, {
      method: 'GET',
      headers: authHeader ? { authorization: authHeader } : {},
    }),
    { params: { id } },
  )
}

// ── test suite ────────────────────────────────────────────────────────────────
describe('GET /api/routes-d/onchain/multisig-broadcasts/[id]/confirmation', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.useFakeTimers()
    // Fix time: 60 s after broadcastAt (2026-01-01T00:00:00Z → 12 ledger closes at 5 s each)
    vi.setSystemTime(new Date('2026-01-01T00:01:00.000Z'))
    mockedVerify.mockResolvedValue({ userId: PRIVY_ID } as never)
    userDelegate.findUnique.mockResolvedValue({ id: USER_ID })
    broadcastDelegate.findUnique.mockResolvedValue(makeBroadcast())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ── auth / input validation ─────────────────────────────────────────────────
  it('returns 401 when no Authorization header is present', async () => {
    const res = await makeGet(BROADCAST_ID, null)
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Unauthorized')
  })

  it('returns 401 when the token fails verification', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await makeGet(BROADCAST_ID)
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Invalid token')
  })

  it('returns 404 when the authenticated user does not exist in the database', async () => {
    userDelegate.findUnique.mockResolvedValue(null)
    const res = await makeGet(BROADCAST_ID)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('User not found')
  })

  // ── broadcast lookup ────────────────────────────────────────────────────────
  it('returns 404 when the broadcast record is not found (network propagation: client should retry)', async () => {
    broadcastDelegate.findUnique.mockResolvedValue(null)
    const res = await makeGet(BROADCAST_ID)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('Broadcast not found')
  })

  // ── authorization ───────────────────────────────────────────────────────────
  it('returns 403 when the user is neither a signer nor the proposer', async () => {
    broadcastDelegate.findUnique.mockResolvedValue(
      makeBroadcast({
        proposal: {
          id: PROPOSAL_ID,
          walletId: WALLET_ID,
          proposerId: OTHER_USER_ID,
          wallet: { signers: [{ userId: 'completely-different-user' }] },
        },
      }),
    )
    const res = await makeGet(BROADCAST_ID)
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('Forbidden')
  })

  it('allows access when the user is the proposer (not in signers list)', async () => {
    broadcastDelegate.findUnique.mockResolvedValue(
      makeBroadcast({
        proposal: {
          id: PROPOSAL_ID,
          walletId: WALLET_ID,
          proposerId: USER_ID, // this user IS the proposer
          wallet: { signers: [] },
        },
      }),
    )
    const res = await makeGet(BROADCAST_ID)
    expect(res.status).toBe(200)
  })

  // ── happy path: pending with txHash (normal in-flight) ─────────────────────
  it('returns time-based confirmation count while status is pending with a txHash', async () => {
    // 60 s elapsed / 5 s per ledger = 12, capped at REQUIRED_CONFIRMATIONS - 1 = 11
    const res = await makeGet(BROADCAST_ID)
    expect(res.status).toBe(200)
    const body = await res.json()
    const c = body.confirmation
    expect(c.status).toBe('pending')
    expect(c.confirmations).toBe(11)
    expect(c.requiredConfirmations).toBe(12)
    expect(c.confirmed).toBe(false)
    expect(c.networkFailed).toBe(false)
    expect(c.propagating).toBe(false)
    expect(c.txHash).toBe('0xdeadbeef')
  })

  // ── happy path: pending with null txHash (network propagation delay) ────────
  it('sets propagating=true when status is pending and txHash is null', async () => {
    broadcastDelegate.findUnique.mockResolvedValue(makeBroadcast({ txHash: null }))
    const res = await makeGet(BROADCAST_ID)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.confirmation.propagating).toBe(true)
    expect(body.confirmation.networkFailed).toBe(false)
    expect(body.confirmation.confirmed).toBe(false)
    expect(body.confirmation.txHash).toBeNull()
  })

  // ── happy path: confirmed ───────────────────────────────────────────────────
  it('returns full confirmation count and confirmed=true when status is confirmed', async () => {
    const confirmedAt = new Date('2026-01-01T00:01:00.000Z')
    broadcastDelegate.findUnique.mockResolvedValue(
      makeBroadcast({ status: 'confirmed', txHash: '0xcafe', confirmedAt }),
    )
    const res = await makeGet(BROADCAST_ID)
    expect(res.status).toBe(200)
    const body = await res.json()
    const c = body.confirmation
    expect(c.confirmations).toBe(12)
    expect(c.confirmed).toBe(true)
    expect(c.networkFailed).toBe(false)
    expect(c.propagating).toBe(false)
    expect(c.confirmedAt).toBe(confirmedAt.toISOString())
  })

  // ── failure path: network-rejected / dropped ────────────────────────────────
  it('returns zero confirmations and networkFailed=true when status is failed', async () => {
    broadcastDelegate.findUnique.mockResolvedValue(
      makeBroadcast({
        status: 'failed',
        txHash: '0xdead',
        failureReason: 'insufficient fee',
      }),
    )
    const res = await makeGet(BROADCAST_ID)
    expect(res.status).toBe(200)
    const body = await res.json()
    const c = body.confirmation
    expect(c.confirmations).toBe(0)
    expect(c.confirmed).toBe(false)
    expect(c.networkFailed).toBe(true)
    expect(c.propagating).toBe(false)
    expect(c.failureReason).toBe('insufficient fee')
  })

  // ── response shape completeness ─────────────────────────────────────────────
  it('includes all expected fields in the confirmation payload', async () => {
    const res = await makeGet(BROADCAST_ID)
    const body = await res.json()
    const c = body.confirmation
    expect(c).toHaveProperty('id')
    expect(c).toHaveProperty('proposalId')
    expect(c).toHaveProperty('txHash')
    expect(c).toHaveProperty('network')
    expect(c).toHaveProperty('status')
    expect(c).toHaveProperty('propagating')
    expect(c).toHaveProperty('confirmations')
    expect(c).toHaveProperty('requiredConfirmations')
    expect(c).toHaveProperty('confirmed')
    expect(c).toHaveProperty('networkFailed')
    expect(c).toHaveProperty('failureReason')
    expect(c).toHaveProperty('broadcastAt')
    expect(c).toHaveProperty('confirmedAt')
  })

  // ── edge: early pending (< 1 ledger close elapsed) ─────────────────────────
  it('returns 0 confirmations when broadcast was just submitted', async () => {
    // Move time to only 2 s after broadcastAt — less than 1 ledger close
    vi.setSystemTime(new Date('2026-01-01T00:00:02.000Z'))
    const res = await makeGet(BROADCAST_ID)
    const body = await res.json()
    expect(body.confirmation.confirmations).toBe(0)
    expect(body.confirmation.confirmed).toBe(false)
  })

  // ── internal server error ───────────────────────────────────────────────────
  it('returns 500 when the database throws an unexpected error', async () => {
    broadcastDelegate.findUnique.mockRejectedValue(new Error('DB connection lost'))
    const res = await makeGet(BROADCAST_ID)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Failed to fetch broadcast confirmation')
  })
})
