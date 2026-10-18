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
  multisigBroadcast: {
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

import { GET, POST } from './route'

describe('GET, POST /api/collective-wallets/[id]/proposals/[proposalId]/broadcast-status', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'did:privy:signer_1' })
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user_signer_1',
      email: 'signer1@lancepay.io',
    })
    mockPrisma.collectiveWallet.findUnique.mockResolvedValue({
      id: 'wallet_1',
      name: 'DAO Treasury',
      stellarAddress: 'GDAO123456',
      threshold: 2,
      signers: [{ id: 'ws_1', walletId: 'wallet_1', userId: 'user_signer_1', weight: 1 }],
    })
  })

  it('restricts visibility to wallet signers on the underlying proposal', async () => {
    mockPrisma.collectiveWallet.findUnique.mockResolvedValueOnce({
      id: 'wallet_1',
      name: 'DAO Treasury',
      stellarAddress: 'GDAO123456',
      threshold: 2,
      signers: [{ id: 'ws_2', walletId: 'wallet_1', userId: 'other_signer_99', weight: 1 }],
    })

    const req = new NextRequest(
      'http://localhost/api/collective-wallets/wallet_1/proposals/prop_1/broadcast-status',
      {
        method: 'GET',
        headers: { authorization: 'Bearer valid_token' },
      },
    )

    const res = await GET(req, {
      params: { id: 'wallet_1', proposalId: 'prop_1' },
    })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('NOT_A_SIGNER')
  })

  it('distinguishes pending from confirmed using confirmedAt and surfaces failureReason when status is failed', async () => {
    // 1. Pending broadcast (confirmedAt is null)
    mockPrisma.multisigProposal.findUnique.mockResolvedValueOnce({
      id: 'prop_1',
      walletId: 'wallet_1',
      status: 'pending',
      broadcast: {
        id: 'bc_1',
        proposalId: 'prop_1',
        txHash: 'tx_pending_hash',
        network: 'stellar',
        status: 'pending',
        broadcastAt: new Date('2026-06-05T10:00:00.000Z'),
        confirmedAt: null,
        failureReason: null,
      },
    })

    const pendingReq = new NextRequest(
      'http://localhost/api/collective-wallets/wallet_1/proposals/prop_1/broadcast-status',
      {
        method: 'GET',
        headers: { authorization: 'Bearer valid_token' },
      },
    )
    const pendingRes = await GET(pendingReq, {
      params: { id: 'wallet_1', proposalId: 'prop_1' },
    })
    expect(pendingRes.status).toBe(200)
    const pendingBody = await pendingRes.json()
    expect(pendingBody.broadcast).toMatchObject({
      id: 'bc_1',
      status: 'pending',
      isPending: true,
      isConfirmed: false,
      isFailed: false,
      confirmedAt: null,
      failureReason: null,
    })

    // 2. Confirmed broadcast (confirmedAt is set)
    mockPrisma.multisigProposal.findUnique.mockResolvedValueOnce({
      id: 'prop_1',
      walletId: 'wallet_1',
      status: 'executed',
      broadcast: {
        id: 'bc_1',
        proposalId: 'prop_1',
        txHash: 'tx_confirmed_hash',
        network: 'stellar',
        status: 'confirmed',
        broadcastAt: new Date('2026-06-05T10:00:00.000Z'),
        confirmedAt: new Date('2026-06-05T10:00:06.000Z'),
        failureReason: null,
      },
    })

    const confirmedReq = new NextRequest(
      'http://localhost/api/collective-wallets/wallet_1/proposals/prop_1/broadcast-status',
      {
        method: 'GET',
        headers: { authorization: 'Bearer valid_token' },
      },
    )
    const confirmedRes = await GET(confirmedReq, {
      params: { id: 'wallet_1', proposalId: 'prop_1' },
    })
    expect(confirmedRes.status).toBe(200)
    const confirmedBody = await confirmedRes.json()
    expect(confirmedBody.broadcast).toMatchObject({
      status: 'confirmed',
      isConfirmed: true,
      isPending: false,
      confirmedAt: '2026-06-05T10:00:06.000Z',
    })

    // 3. Failed broadcast (surfaces failureReason)
    mockPrisma.multisigProposal.findUnique.mockResolvedValueOnce({
      id: 'prop_1',
      walletId: 'wallet_1',
      status: 'failed',
      broadcast: {
        id: 'bc_1',
        proposalId: 'prop_1',
        txHash: 'tx_failed_hash',
        network: 'stellar',
        status: 'failed',
        broadcastAt: new Date('2026-06-05T10:00:00.000Z'),
        confirmedAt: null,
        failureReason: 'tx_bad_auth_extra: invalid signature weight on Horizon',
      },
    })

    const failedReq = new NextRequest(
      'http://localhost/api/collective-wallets/wallet_1/proposals/prop_1/broadcast-status',
      {
        method: 'GET',
        headers: { authorization: 'Bearer valid_token' },
      },
    )
    const failedRes = await GET(failedReq, {
      params: { id: 'wallet_1', proposalId: 'prop_1' },
    })
    expect(failedRes.status).toBe(200)
    const failedBody = await failedRes.json()
    expect(failedBody.broadcast).toMatchObject({
      status: 'failed',
      isFailed: true,
      isConfirmed: false,
      failureReason: 'tx_bad_auth_extra: invalid signature weight on Horizon',
    })
    expect(failedBody.failureReason).toBe(
      'tx_bad_auth_extra: invalid signature weight on Horizon',
    )
  })

  it('enforces the unique proposalId constraint on MultisigBroadcast when creating one', async () => {
    mockPrisma.multisigProposal.findUnique.mockResolvedValueOnce({
      id: 'prop_1',
      walletId: 'wallet_1',
      status: 'pending',
      broadcast: null,
    })
    mockPrisma.multisigBroadcast.findUnique.mockResolvedValueOnce(null)
    mockPrisma.multisigBroadcast.create.mockResolvedValueOnce({
      id: 'bc_created_1',
      proposalId: 'prop_1',
      txHash: 'tx_new_hash',
      network: 'stellar',
      status: 'pending',
      broadcastAt: new Date('2026-06-05T10:00:00.000Z'),
      confirmedAt: null,
      failureReason: null,
    })

    const createReq = new NextRequest(
      'http://localhost/api/collective-wallets/wallet_1/proposals/prop_1/broadcast-status',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          txHash: 'tx_new_hash',
          network: 'stellar',
        }),
      },
    )
    const createRes = await POST(createReq, {
      params: { id: 'wallet_1', proposalId: 'prop_1' },
    })
    expect(createRes.status).toBe(201)

    // Second creation attempt for the same proposalId is rejected with 409
    mockPrisma.multisigProposal.findUnique.mockResolvedValueOnce({
      id: 'prop_1',
      walletId: 'wallet_1',
      status: 'pending',
      broadcast: { id: 'bc_created_1', proposalId: 'prop_1' },
    })

    const dupReq = new NextRequest(
      'http://localhost/api/collective-wallets/wallet_1/proposals/prop_1/broadcast-status',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ txHash: 'tx_second_hash' }),
      },
    )
    const dupRes = await POST(dupReq, {
      params: { id: 'wallet_1', proposalId: 'prop_1' },
    })
    expect(dupRes.status).toBe(409)
    const dupBody = await dupRes.json()
    expect(dupBody.code).toBe('BROADCAST_ALREADY_EXISTS')
  })
})
