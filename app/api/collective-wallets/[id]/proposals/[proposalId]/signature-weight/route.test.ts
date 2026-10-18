import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockPrisma = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
  },
  collectiveWallet: {
    findUnique: vi.fn(),
  },
  multisigProposal: {
    findUnique: vi.fn(),
  },
  proposalSignature: {
    findMany: vi.fn(),
  },
}))

const mockVerifyAuthToken = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { GET } from './route'

describe('GET /api/collective-wallets/[id]/proposals/[proposalId]/signature-weight', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'did:privy:signer_1' })
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user_signer_1',
      email: 'signer1@lancepay.io',
    })
  })

  it('restricts visibility to wallet signers and rejects non-signers with 403', async () => {
    mockPrisma.collectiveWallet.findUnique.mockResolvedValue({
      id: 'wallet_multisig_1',
      name: 'Studio Treasury',
      stellarAddress: 'GSTUDIO123456',
      threshold: 5,
      signers: [
        { id: 'ws_2', walletId: 'wallet_multisig_1', userId: 'user_signer_2', weight: 3 },
        { id: 'ws_3', walletId: 'wallet_multisig_1', userId: 'user_signer_3', weight: 2 },
      ],
    })

    const req = new NextRequest(
      'http://localhost/api/collective-wallets/wallet_multisig_1/proposals/prop_1/signature-weight',
      {
        method: 'GET',
        headers: { authorization: 'Bearer valid_token' },
      },
    )

    const res = await GET(req, {
      params: { id: 'wallet_multisig_1', proposalId: 'prop_1' },
    })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('NOT_A_SIGNER')
    expect(mockPrisma.multisigProposal.findUnique).not.toHaveBeenCalled()
  })

  it('joins each ProposalSignature to its corresponding WalletSigner weight and computes thresholdMet', async () => {
    // Signer 1 has weight 3, Signer 2 has weight 1, Signer 3 has weight 2; threshold = 5
    mockPrisma.collectiveWallet.findUnique.mockResolvedValue({
      id: 'wallet_multisig_1',
      name: 'Studio Treasury',
      stellarAddress: 'GSTUDIO123456',
      threshold: 5,
      signers: [
        { id: 'ws_1', walletId: 'wallet_multisig_1', userId: 'user_signer_1', weight: 3 },
        { id: 'ws_2', walletId: 'wallet_multisig_1', userId: 'user_signer_2', weight: 1 },
        { id: 'ws_3', walletId: 'wallet_multisig_1', userId: 'user_signer_3', weight: 2 },
      ],
    })

    // First check: Signer 1 (weight 3) + Signer 2 (weight 1) = total weight 4 (< threshold 5 -> thresholdMet: false)
    mockPrisma.multisigProposal.findUnique.mockResolvedValueOnce({
      id: 'prop_1',
      walletId: 'wallet_multisig_1',
      proposerId: 'user_signer_1',
      destinationAddress: 'GDEST123',
      amountUsdc: '1000.000000',
      status: 'pending',
      expiresAt: new Date('2026-06-10T00:00:00.000Z'),
      signatures: [
        {
          id: 'sig_1',
          proposalId: 'prop_1',
          signerId: 'user_signer_1',
          createdAt: new Date('2026-06-05T10:00:00.000Z'),
        },
        {
          id: 'sig_2',
          proposalId: 'prop_1',
          signerId: 'user_signer_2',
          createdAt: new Date('2026-06-05T10:05:00.000Z'),
        },
      ],
    })

    const subThresholdReq = new NextRequest(
      'http://localhost/api/collective-wallets/wallet_multisig_1/proposals/prop_1/signature-weight',
      {
        method: 'GET',
        headers: { authorization: 'Bearer valid_token' },
      },
    )
    const subRes = await GET(subThresholdReq, {
      params: { id: 'wallet_multisig_1', proposalId: 'prop_1' },
    })
    expect(subRes.status).toBe(200)
    const subBody = await subRes.json()

    // 2 signatures, but total weight is 3 + 1 = 4 (not 2!)
    expect(subBody).toMatchObject({
      walletId: 'wallet_multisig_1',
      proposalId: 'prop_1',
      totalWeight: 4,
      currentWeight: 4,
      threshold: 5,
      requiredThreshold: 5,
      thresholdMet: false,
      isThresholdMet: false,
      remainingWeight: 1,
      signatureCount: 2,
    })
    expect(subBody.signatures.map((s: any) => ({ signerId: s.signerId, weight: s.weight }))).toEqual([
      { signerId: 'user_signer_1', weight: 3 },
      { signerId: 'user_signer_2', weight: 1 },
    ])

    // Second check: Signer 1 (weight 3) + Signer 3 (weight 2) = total weight 5 (>= threshold 5 -> thresholdMet: true)
    mockPrisma.multisigProposal.findUnique.mockResolvedValueOnce({
      id: 'prop_1',
      walletId: 'wallet_multisig_1',
      proposerId: 'user_signer_1',
      destinationAddress: 'GDEST123',
      amountUsdc: '1000.000000',
      status: 'pending',
      expiresAt: new Date('2026-06-10T00:00:00.000Z'),
      signatures: [
        {
          id: 'sig_1',
          proposalId: 'prop_1',
          signerId: 'user_signer_1',
          createdAt: new Date('2026-06-05T10:00:00.000Z'),
        },
        {
          id: 'sig_3',
          proposalId: 'prop_1',
          signerId: 'user_signer_3',
          createdAt: new Date('2026-06-05T10:10:00.000Z'),
        },
      ],
    })

    const metReq = new NextRequest(
      'http://localhost/api/collective-wallets/wallet_multisig_1/proposals/prop_1/signature-weight',
      {
        method: 'GET',
        headers: { authorization: 'Bearer valid_token' },
      },
    )
    const metRes = await GET(metReq, {
      params: { id: 'wallet_multisig_1', proposalId: 'prop_1' },
    })
    expect(metRes.status).toBe(200)
    const metBody = await metRes.json()

    expect(metBody).toMatchObject({
      totalWeight: 5,
      threshold: 5,
      thresholdMet: true,
      isThresholdMet: true,
      remainingWeight: 0,
    })
  })
})
