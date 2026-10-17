import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Account, Keypair } from '@stellar/stellar-sdk'

const { mockPrisma, mockVerifyAuthToken, mockServer } = vi.hoisted(() => ({
  mockPrisma: {
    user: {
      findUnique: vi.fn(),
    },
    claimableBalance: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    journalEntry: {
      create: vi.fn(),
    },
  },
  mockVerifyAuthToken: vi.fn(),
  mockServer: {
    ledgers: vi.fn(),
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

import { POST } from './route'

const USER_WALLET = Keypair.random().publicKey()
// Valid 36-byte hex ClaimableBalanceId (1 byte type 0x00 + 32 bytes hash = 36 bytes = 72 hex chars)
const VALID_BALANCE_ID =
  '00000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function makePostRequest(
  id: string,
  body: unknown = {},
  token: string | null = 'valid-token',
): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest(
    `http://localhost/api/stellar/claimable-balances/${id}/claim`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
  )
}

function mockLedgerClosedAt(isoString: string) {
  mockServer.ledgers.mockReturnValue({
    order: () => ({
      limit: () => ({
        call: vi.fn().mockResolvedValue({
          records: [{ closed_at: isoString }],
        }),
      }),
    }),
  })
}

describe('POST /api/stellar/claimable-balances/[id]/claim', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'privy-1' })
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      wallet: { address: USER_WALLET },
    })
    mockLedgerClosedAt('2026-03-10T12:00:00.000Z')
    mockServer.fetchBaseFee.mockResolvedValue(100)
    mockServer.loadAccount.mockResolvedValue(new Account(USER_WALLET, '100'))
  })

  it('rejects claims when beneficiary mirror row does not match authenticated caller', async () => {
    mockPrisma.claimableBalance.findUnique.mockResolvedValueOnce({
      id: 'cb-1',
      balanceId: VALID_BALANCE_ID,
      beneficiaryUserId: 'other-user-99',
      status: 'pending',
    })

    const res = await POST(makePostRequest('cb-1'), { params: { id: 'cb-1' } })
    expect(res.status).toBe(403)
    expect(mockServer.submitTransaction).not.toHaveBeenCalled()
  })

  it('evaluates predicate using authoritative ledger time and ignores forged client timestamps', async () => {
    // Ledger time is 2026-03-10T12:00:00Z, unlockAt is 2026-03-15T00:00:00Z
    mockPrisma.claimableBalance.findUnique.mockResolvedValueOnce({
      id: 'cb-locked',
      balanceId: VALID_BALANCE_ID,
      beneficiaryUserId: 'user-1',
      status: 'pending',
      predicate: { notBefore: '2026-03-15T00:00:00.000Z' },
    })

    // Client tries to pass a future timestamp in request body to bypass time lock
    const res = await POST(
      makePostRequest('cb-locked', {
        clientTimestamp: '2026-03-20T00:00:00.000Z',
      }),
      { params: { id: 'cb-locked' } },
    )
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.code).toBe('PREDICATE_NOT_SATISFIED')
    expect(mockServer.submitTransaction).not.toHaveBeenCalled()
  })

  it('does NOT mark the mirror row as claimed if Horizon submission fails', async () => {
    mockPrisma.claimableBalance.findUnique.mockResolvedValueOnce({
      id: 'cb-mature',
      balanceId: VALID_BALANCE_ID,
      beneficiaryUserId: 'user-1',
      amount: '250.00',
      assetCode: 'USDC',
      status: 'pending',
      predicate: { notBefore: '2026-03-01T00:00:00.000Z' },
    })
    mockServer.submitTransaction.mockRejectedValueOnce(
      new Error('Horizon op_claimable_balance_does_not_exist'),
    )

    const res = await POST(makePostRequest('cb-mature'), {
      params: { id: 'cb-mature' },
    })
    expect(res.status).toBe(500)
    expect(mockPrisma.claimableBalance.update).not.toHaveBeenCalled()
    expect(mockPrisma.journalEntry.create).not.toHaveBeenCalled()
  })

  it('claims matured balance on Horizon and marks mirror row claimed after confirmation', async () => {
    mockPrisma.claimableBalance.findUnique.mockResolvedValueOnce({
      id: 'cb-mature',
      balanceId: VALID_BALANCE_ID,
      beneficiaryUserId: 'user-1',
      amount: '250.00',
      assetCode: 'USDC',
      status: 'pending',
      predicate: { notBefore: '2026-03-01T00:00:00.000Z' },
    })
    mockServer.submitTransaction.mockResolvedValueOnce({
      hash: 'stellar-tx-hash-999',
    })
    mockPrisma.claimableBalance.update.mockResolvedValueOnce({
      id: 'cb-mature',
      status: 'claimed',
      claimTxHash: 'stellar-tx-hash-999',
    })
    mockPrisma.journalEntry.create.mockResolvedValueOnce({ id: 'je-1' })

    const res = await POST(makePostRequest('cb-mature'), {
      params: { id: 'cb-mature' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.claimed).toBe(true)
    expect(body.txHash).toBe('stellar-tx-hash-999')
    expect(mockPrisma.claimableBalance.update).toHaveBeenCalledWith({
      where: { id: 'cb-mature' },
      data: expect.objectContaining({
        status: 'claimed',
        claimTxHash: 'stellar-tx-hash-999',
      }),
    })
    expect(mockPrisma.journalEntry.create).toHaveBeenCalledOnce()
  })
})
