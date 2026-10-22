import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Keypair } from '@stellar/stellar-sdk'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    collectiveWallet: { findUnique: vi.fn() },
    walletSigner: { findMany: vi.fn() },
    multisigProposal: { findMany: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

import { GET } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const WALLET_ADDRESS = Keypair.random().publicKey()
const NOW = new Date('2026-10-15T12:00:00Z')
const ctx = () => ({ params: Promise.resolve({ id: 'wallet-1' }) })

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/collective-wallets/wallet-1/proposals/pending', {
    method: 'GET',
    headers: { authorization: 'Bearer token' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1', email: 'caller@example.com' } as any)
  vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue({
    id: 'wallet-1',
    stellarAddress: WALLET_ADDRESS,
    threshold: 2,
    signers: [{ id: 'ws-1' }],
  } as any)
  vi.mocked(prisma.walletSigner.findMany).mockResolvedValue([
    { userId: 'user-1', weight: 1 },
    { userId: 'user-2', weight: 2 },
  ] as any)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GET /api/collective-wallets/[id]/proposals/pending', () => {
  it('lists pending proposals awaiting caller signature sorted by expiresAt asc', async () => {
    const mockProposals = [
      {
        id: 'prop-urgent',
        walletId: 'wallet-1',
        destinationAddress: 'GDEST1',
        amountUsdc: '100.000000',
        memo: 'urgent',
        status: 'pending',
        expiresAt: new Date('2026-10-16T12:00:00Z'),
        executedAt: null,
        stellarTxHash: null,
        createdAt: new Date('2026-10-14T12:00:00Z'),
        proposer: { id: 'user-2', name: 'Bob', email: 'bob@example.com' },
        signatures: [{ signerId: 'user-2' }],
      },
      {
        id: 'prop-later',
        walletId: 'wallet-1',
        destinationAddress: 'GDEST2',
        amountUsdc: '50.000000',
        memo: 'later',
        status: 'pending',
        expiresAt: new Date('2026-10-17T12:00:00Z'),
        executedAt: null,
        stellarTxHash: null,
        createdAt: new Date('2026-10-14T12:00:00Z'),
        proposer: { id: 'user-2', name: 'Bob', email: 'bob@example.com' },
        signatures: [],
      },
    ]

    vi.mocked(prisma.multisigProposal.findMany).mockResolvedValue(mockProposals as any)

    const res = await GET(makeRequest(), ctx())
    expect(res.status).toBe(200)

    const data = await res.json()
    expect(data.threshold).toBe(2)
    expect(data.proposals).toHaveLength(2)

    // Check weights and thresholds
    expect(data.proposals[0].id).toBe('prop-urgent')
    expect(data.proposals[0].currentSignatureWeight).toBe(2) // user-2 has weight 2
    expect(data.proposals[0].threshold).toBe(2)

    expect(data.proposals[1].id).toBe('prop-later')
    expect(data.proposals[1].currentSignatureWeight).toBe(0)
    expect(data.proposals[1].threshold).toBe(2)

    // Verify filter parameters
    expect(prisma.multisigProposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          walletId: 'wallet-1',
          status: { notIn: ['executed', 'cancelled'] },
          signatures: { none: { signerId: 'user-1' } },
        }),
        orderBy: { expiresAt: 'asc' },
      })
    )
  })

  it('excludes proposals already signed by caller', async () => {
    vi.mocked(prisma.multisigProposal.findMany).mockResolvedValue([])

    await GET(makeRequest(), ctx())

    expect(prisma.multisigProposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          signatures: { none: { signerId: 'user-1' } },
        }),
      })
    )
  })

  it('excludes proposals that are expired or executed in query filter', async () => {
    vi.mocked(prisma.multisigProposal.findMany).mockResolvedValue([])

    await GET(makeRequest(), ctx())

    const callArgs = vi.mocked(prisma.multisigProposal.findMany).mock.calls[0][0] as any
    expect(callArgs.where.status).toEqual({ notIn: ['executed', 'cancelled'] })
    expect(callArgs.where.expiresAt).toEqual({ gt: NOW })
  })

  it('returns 403 when caller is not a wallet signer', async () => {
    vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue({
      id: 'wallet-1',
      stellarAddress: WALLET_ADDRESS,
      threshold: 2,
      signers: [],
    } as any)

    const res = await GET(makeRequest(), ctx())
    expect(res.status).toBe(403)
    const data = await res.json()
    expect(data.code).toBe('NOT_A_SIGNER')
  })

  it('returns 404 when wallet does not exist', async () => {
    vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue(null)

    const res = await GET(makeRequest(), ctx())
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.code).toBe('WALLET_NOT_FOUND')
  })

  it('returns 401 when request is unauthenticated', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null as any)

    const res = await GET(makeRequest(), ctx())
    expect(res.status).toBe(401)
  })
})
