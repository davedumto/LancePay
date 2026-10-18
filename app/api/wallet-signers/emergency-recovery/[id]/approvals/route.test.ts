import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'vitest'

const mockPrisma = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
  },
  emergencyRecovery: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  emergencyRecoveryApproval: {
    findUnique: vi.fn(),
    create: vi.fn(),
  },
}))

const mockVerifyAuthToken = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { NextRequest as NextReq } from 'next/server'
import { GET, POST } from './route'

describe('GET, POST /api/wallet-signers/emergency-recovery/[id]/approvals', () => {
  const futureExpiry = new Date(Date.now() + 3600_000)

  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'did:privy:admin_rev_1' })
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'admin_reviewer_1',
      email: 'reviewer1@lancepay.io',
      role: 'admin',
    })
    mockPrisma.emergencyRecovery.findUnique.mockResolvedValue({
      id: 'rec_100',
      walletId: 'wallet_100',
      initiatorId: 'admin_initiator',
      justification: 'Hardware HSM module failure on primary co-signers',
      status: 'pending',
      signerCountAtRequest: 2,
      thresholdAtRequest: 3,
      activeSignerCount: 2,
      expiresAt: futureExpiry,
      createdAt: new Date('2026-06-05T10:00:00.000Z'),
      approvals: [],
      wallet: {
        id: 'wallet_100',
        signers: [
          { userId: 'admin_initiator' },
          { userId: 'admin_reviewer_1' },
          { userId: 'admin_reviewer_2' },
        ],
      },
    })
    mockPrisma.emergencyRecoveryApproval.findUnique.mockResolvedValue(null)
  })

  it('validates decision is either approve or reject and records a valid decision', async () => {
    const invalidReq = new NextReq(
      'http://localhost/api/wallet-signers/emergency-recovery/rec_100/approvals',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          decision: 'abstain',
        }),
      },
    )

    const invalidRes = await POST(invalidReq, { params: { id: 'rec_100' } })
    expect(invalidRes.status).toBe(400)
    const invalidBody = await invalidRes.json()
    expect(invalidBody.code).toBe('INVALID_RECOVERY_DECISION')
    expect(mockPrisma.emergencyRecoveryApproval.create).not.toHaveBeenCalled()

    // Valid decision: 'approve'
    mockPrisma.emergencyRecoveryApproval.create.mockResolvedValueOnce({
      id: 'app_1',
      recoveryId: 'rec_100',
      approverId: 'admin_reviewer_1',
      decision: 'approve',
      note: 'Verified hardware outage ticket #INC-801',
      createdAt: new Date('2026-06-05T10:15:00.000Z'),
    })

    const approveReq = new NextReq(
      'http://localhost/api/wallet-signers/emergency-recovery/rec_100/approvals',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          decision: 'approve',
          note: 'Verified hardware outage ticket #INC-801',
        }),
      },
    )

    const approveRes = await POST(approveReq, { params: { id: 'rec_100' } })
    expect(approveRes.status).toBe(201)
    const approveBody = await approveRes.json()
    expect(approveBody.approval).toMatchObject({
      id: 'app_1',
      recoveryId: 'rec_100',
      approverId: 'admin_reviewer_1',
      decision: 'approve',
      note: 'Verified hardware outage ticket #INC-801',
    })
  })

  it('enforces the unique (recoveryId, approverId) constraint so each admin can only approve or reject once', async () => {
    // Case A: admin already appears in existing approvals
    mockPrisma.emergencyRecovery.findUnique.mockResolvedValueOnce({
      id: 'rec_100',
      walletId: 'wallet_100',
      initiatorId: 'admin_initiator',
      status: 'pending',
      expiresAt: futureExpiry,
      approvals: [
        {
          id: 'app_existing',
          recoveryId: 'rec_100',
          approverId: 'admin_reviewer_1',
          decision: 'approve',
        },
      ],
      wallet: {
        id: 'wallet_100',
        signers: [{ userId: 'admin_reviewer_1' }],
      },
    })

    const dupReq = new NextReq(
      'http://localhost/api/wallet-signers/emergency-recovery/rec_100/approvals',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ decision: 'reject' }),
      },
    )
    const dupRes = await POST(dupReq, { params: { id: 'rec_100' } })
    expect(dupRes.status).toBe(409)
    const dupBody = await dupRes.json()
    expect(dupBody.code).toBe('DUPLICATE_APPROVAL_DECISION')
    expect(mockPrisma.emergencyRecoveryApproval.create).not.toHaveBeenCalled()

    // Case B: concurrent race hits Prisma P2002 unique constraint
    mockPrisma.emergencyRecoveryApproval.create.mockRejectedValueOnce({
      code: 'P2002',
    })
    const raceReq = new NextReq(
      'http://localhost/api/wallet-signers/emergency-recovery/rec_100/approvals',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ decision: 'approve' }),
      },
    )
    const raceRes = await POST(raceReq, { params: { id: 'rec_100' } })
    expect(raceRes.status).toBe(409)
  })

  it('permits only admins eligible to review this specific recovery request', async () => {
    // 1. Non-admin user -> 403
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'admin_reviewer_1',
      email: 'user@lancepay.io',
      role: 'user',
    })
    const nonAdminReq = new NextReq(
      'http://localhost/api/wallet-signers/emergency-recovery/rec_100/approvals',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ decision: 'approve' }),
      },
    )
    const nonAdminRes = await POST(nonAdminReq, { params: { id: 'rec_100' } })
    expect(nonAdminRes.status).toBe(403)

    // 2. Initiating admin attempting to self-approve -> 403
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'admin_initiator',
      email: 'initiator@lancepay.io',
      role: 'admin',
    })
    const selfApproveReq = new NextReq(
      'http://localhost/api/wallet-signers/emergency-recovery/rec_100/approvals',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ decision: 'approve' }),
      },
    )
    const selfApproveRes = await POST(selfApproveReq, {
      params: { id: 'rec_100' },
    })
    expect(selfApproveRes.status).toBe(403)
    const selfBody = await selfApproveRes.json()
    expect(selfBody.code).toBe('FORBIDDEN_SELF_APPROVAL')

    // 3. Unrelated admin not on the wallet's eligible signer list -> 403
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'admin_unrelated_99',
      email: 'unrelated@lancepay.io',
      role: 'admin',
    })
    const unrelatedAdminReq = new NextReq(
      'http://localhost/api/wallet-signers/emergency-recovery/rec_100/approvals',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ decision: 'approve' }),
      },
    )
    const unrelatedRes = await POST(unrelatedAdminReq, {
      params: { id: 'rec_100' },
    })
    expect(unrelatedRes.status).toBe(403)
    const unrelatedBody = await unrelatedRes.json()
    expect(unrelatedBody.code).toBe('FORBIDDEN_NOT_ELIGIBLE_REVIEWER')

    // 4. Eligible admin can also GET the approvals list
    const getReq = new NextReq(
      'http://localhost/api/wallet-signers/emergency-recovery/rec_100/approvals',
      {
        method: 'GET',
        headers: { authorization: 'Bearer valid_token' },
      },
    )
    const getRes = await GET(getReq, { params: { id: 'rec_100' } })
    expect(getRes.status).toBe(200)
  })
})
