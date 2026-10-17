import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Account, Asset, Keypair } from '@stellar/stellar-sdk'

const { mockPrisma, mockVerifyAuthToken, mockServer } = vi.hoisted(() => ({
  mockPrisma: {
    user: {
      findUnique: vi.fn(),
    },
    claimableBalance: {
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
  USDC_ASSET: new Asset(
    'USDC',
    'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  ),
}))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { POST, MAX_CLAIMANTS_PER_BALANCE } from './route'

const SOURCE_WALLET = Keypair.random().publicKey()
const BENEFICIARY_WALLET = Keypair.random().publicKey()

function makePostRequest(
  body: unknown,
  token: string | null = 'valid-token',
): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest(
    'http://localhost/api/stellar/claimable-balances/create',
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
  )
}

describe('POST /api/stellar/claimable-balances/create', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'privy-1' })
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1' })
    mockServer.fetchBaseFee.mockResolvedValue(100)
    mockServer.loadAccount.mockResolvedValue(new Account(SOURCE_WALLET, '100'))
  })

  it('rejects raw XDR predicate inputs with 400', async () => {
    const resTopLevel = await POST(
      makePostRequest({
        invoiceId: 'inv-1',
        amount: 200,
        rawXdr: 'AAAA...',
        claimants: [{ destination: BENEFICIARY_WALLET }],
      }),
    )
    expect(resTopLevel.status).toBe(400)
    expect((await resTopLevel.json()).code).toBe('RAW_XDR_REJECTED')

    const resClaimantXdr = await POST(
      makePostRequest({
        invoiceId: 'inv-1',
        amount: 200,
        claimants: [
          {
            destination: BENEFICIARY_WALLET,
            predicateXdr: 'AAAA...',
          },
        ],
      }),
    )
    expect(resClaimantXdr.status).toBe(400)
    expect((await resClaimantXdr.json()).code).toBe('RAW_XDR_REJECTED')
  })

  it('enforces maximum claimants per balance so predicate size cannot grow unbounded', async () => {
    const tooManyClaimants = Array.from(
      { length: MAX_CLAIMANTS_PER_BALANCE + 1 },
      () => ({
        destination: Keypair.random().publicKey(),
        predicate: { type: 'unconditional' },
      }),
    )

    const res = await POST(
      makePostRequest({
        invoiceId: 'inv-1',
        amount: 100,
        claimants: tooManyClaimants,
      }),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('MAX_CLAIMANTS_EXCEEDED')
    expect(mockServer.submitTransaction).not.toHaveBeenCalled()
  })

  it('requires invoiceId or payoutId to link the mirror row', async () => {
    const res = await POST(
      makePostRequest({
        amount: 100,
        claimants: [{ destination: BENEFICIARY_WALLET }],
      }),
    )
    expect(res.status).toBe(400)
  })

  it('encodes structured time-lock predicate, submits transaction, and persists mirror row linked to invoiceId', async () => {
    mockServer.submitTransaction.mockResolvedValueOnce({
      hash: 'tx-create-cb-123',
      balanceId:
        '00000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    })
    mockPrisma.claimableBalance.create.mockImplementationOnce(async ({ data }) => ({
      id: 'mirror-1',
      ...data,
    }))

    const res = await POST(
      makePostRequest({
        invoiceId: 'inv-55',
        amount: 450,
        claimants: [
          {
            destination: BENEFICIARY_WALLET,
            beneficiaryUserId: 'freelancer-1',
            predicate: {
              type: 'window',
              unlockAt: '2026-04-01T00:00:00.000Z',
              expiresAt: '2026-04-30T00:00:00.000Z',
            },
          },
        ],
      }),
    )
    expect(res.status).toBe(201)
    const body = await res.json()

    expect(body.balanceId).toBe(
      '00000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    )
    expect(body.invoiceId).toBe('inv-55')
    expect(body.mirror).toMatchObject({
      id: 'mirror-1',
      invoiceId: 'inv-55',
      beneficiaryUserId: 'freelancer-1',
      beneficiaryAddress: BENEFICIARY_WALLET,
      status: 'pending',
      txHash: 'tx-create-cb-123',
    })
    expect(mockPrisma.claimableBalance.create).toHaveBeenCalledOnce()
  })
})
