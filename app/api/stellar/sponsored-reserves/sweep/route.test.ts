import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Account, Keypair } from '@stellar/stellar-sdk'

const { mockPrisma, mockVerifyAuthToken, mockServer } = vi.hoisted(() => ({
  mockPrisma: {
    user: {
      findUnique: vi.fn(),
    },
    sponsoredReserve: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    sponsorshipLedger: {
      create: vi.fn(),
    },
  },
  mockVerifyAuthToken: vi.fn(),
  mockServer: {
    loadAccount: vi.fn(),
    fetchBaseFee: vi.fn(),
    submitTransaction: vi.fn(),
  },
}))

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))
vi.mock('@/lib/stellar', () => ({
  server: mockServer,
  STELLAR_NETWORK: 'Test SDF Network ; September 2015',
}))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { POST, MAX_SWEEP_BATCH_SIZE } from './route'

const SPONSOR_WALLET = Keypair.random().publicKey()
const MERGED_WALLET = Keypair.random().publicKey()
const RETIRED_WALLET = Keypair.random().publicKey()
const ACTIVE_WALLET = Keypair.random().publicKey()

function makePostRequest(
  body: unknown = {},
  token: string | null = 'valid-token',
): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest(
    'http://localhost/api/stellar/sponsored-reserves/sweep',
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
  )
}

describe('POST /api/stellar/sponsored-reserves/sweep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'privy-admin', role: 'admin' })
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'admin-1', role: 'admin' })
    mockServer.fetchBaseFee.mockResolvedValue(100)
    mockServer.loadAccount.mockResolvedValue(new Account(SPONSOR_WALLET, '100'))
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await POST(makePostRequest({}, null))
    expect(res.status).toBe(401)
  })

  it('rejects batchSize exceeding MAX_SWEEP_BATCH_SIZE so sweep never produces an oversize transaction', async () => {
    const res = await POST(
      makePostRequest({ batchSize: MAX_SWEEP_BATCH_SIZE + 5 }),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('INVALID_BATCH_SIZE')
  })

  it('sweeps only merged/retired beneficiaries in a bounded batch and records each reclaim on the sponsorship ledger', async () => {
    mockPrisma.sponsoredReserve.findMany.mockResolvedValueOnce([
      {
        id: 'sr-1',
        sponsorAccount: SPONSOR_WALLET,
        beneficiaryAccount: MERGED_WALLET,
        beneficiaryStatus: 'merged',
        reserveSubentries: 2,
        status: 'active',
      },
      {
        id: 'sr-2',
        sponsorAccount: SPONSOR_WALLET,
        beneficiaryAccount: RETIRED_WALLET,
        beneficiaryStatus: 'retired',
        reserveSubentries: 3,
        status: 'active',
      },
      // Active account should be filtered out defensively even if returned
      {
        id: 'sr-3',
        sponsorAccount: SPONSOR_WALLET,
        beneficiaryAccount: ACTIVE_WALLET,
        beneficiaryStatus: 'active',
        reserveSubentries: 2,
        status: 'active',
      },
    ])
    mockServer.submitTransaction.mockResolvedValueOnce({
      hash: 'sweep-tx-hash-777',
    })
    mockPrisma.sponsoredReserve.updateMany.mockResolvedValueOnce({ count: 2 })
    mockPrisma.sponsorshipLedger.create.mockImplementation(async ({ data }) => ({
      id: `ledger-${data.sponsoredReserveId}`,
      ...data,
    }))

    const res = await POST(makePostRequest({ batchSize: 10 }))
    expect(res.status).toBe(200)
    const body = await res.json()

    // 2 subentries (1.0 XLM) + 3 subentries (1.5 XLM) = 2.5 XLM reclaimed
    expect(body.sweptCount).toBe(2)
    expect(body.reclaimedXlm).toBe('2.5000000')
    expect(body.txHash).toBe('sweep-tx-hash-777')
    expect(body.ledgerEntries).toHaveLength(2)
    expect(mockPrisma.sponsorshipLedger.create).toHaveBeenCalledTimes(2)
    expect(mockPrisma.sponsoredReserve.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['sr-1', 'sr-2'] } },
      data: expect.objectContaining({
        status: 'swept',
        sweepTxHash: 'sweep-tx-hash-777',
      }),
    })
  })
})
