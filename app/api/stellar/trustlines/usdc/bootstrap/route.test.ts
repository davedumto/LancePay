import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Account, Asset, Keypair } from '@stellar/stellar-sdk'

const { mockPrisma, mockVerifyAuthToken, mockServer, USDC_ISSUER } = vi.hoisted(() => ({
  USDC_ISSUER: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  mockPrisma: {
    user: {
      findUnique: vi.fn(),
    },
    trustlineBootstrap: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
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
  USDC_ASSET: new Asset('USDC', USDC_ISSUER),
}))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { POST } from './route'

const USER_WALLET = Keypair.random().publicKey()
const SPONSOR_WALLET = Keypair.random().publicKey()

function makePostRequest(
  body: unknown = {},
  token: string | null = 'valid-token',
): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest(
    'http://localhost/api/stellar/trustlines/usdc/bootstrap',
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
  )
}

function makeHorizonAccount(address: string, balances: unknown[] = []) {
  const acc = new Account(address, '100') as Account & { balances: unknown[] }
  acc.balances = balances
  return acc
}

describe('POST /api/stellar/trustlines/usdc/bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'privy-1' })
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      wallet: { address: USER_WALLET },
    })
    mockPrisma.trustlineBootstrap.findUnique.mockResolvedValue(null)
    mockServer.fetchBaseFee.mockResolvedValue(100)
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await POST(makePostRequest({}, null))
    expect(res.status).toBe(401)
  })

  it('returns 403 when supplied walletAddress does not match authenticated user wallet', async () => {
    const otherWallet = Keypair.random().publicKey()
    const res = await POST(makePostRequest({ walletAddress: otherWallet }))
    expect(res.status).toBe(403)
  })

  it('rejects bootstrap with 409 when wallet already carries an active USDC trustline', async () => {
    mockServer.loadAccount.mockResolvedValueOnce(
      makeHorizonAccount(USER_WALLET, [
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: USDC_ISSUER,
          balance: '10.0000000',
        },
      ]),
    )

    const res = await POST(makePostRequest())
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('USDC_TRUSTLINE_ALREADY_EXISTS')
    expect(mockServer.submitTransaction).not.toHaveBeenCalled()
  })

  it('treats Horizon submission failure as retryable (503) and leaves an idempotent sentinel for the next retry', async () => {
    mockServer.loadAccount
      .mockResolvedValueOnce(makeHorizonAccount(USER_WALLET, [{ asset_type: 'native', balance: '0.0000000' }]))
      .mockResolvedValueOnce(makeHorizonAccount(SPONSOR_WALLET, [{ asset_type: 'native', balance: '500.0000000' }]))

    mockServer.submitTransaction.mockRejectedValueOnce(
      new Error('Horizon 504 Gateway Timeout (tx_bad_seq)'),
    )
    mockPrisma.trustlineBootstrap.upsert.mockImplementationOnce(async ({ create }) => ({
      id: 'sentinel-1',
      ...create,
    }))

    const res = await POST(makePostRequest())
    expect(res.status).toBe(503)
    const body = await res.json()

    expect(body.retryable).toBe(true)
    expect(body.idempotencyKey).toBe(`usdc-trustline:${USER_WALLET}`)
    expect(body.sentinel.status).toBe('retry_pending')
    expect(body.sentinel.attemptCount).toBe(1)
    expect(body.sentinel.lastError).toContain('Horizon 504 Gateway Timeout')
  })

  it('resumes from existing sentinel on retry and submits sponsor-paid changeTrust operation', async () => {
    mockPrisma.trustlineBootstrap.findUnique.mockResolvedValueOnce({
      id: 'sentinel-1',
      walletAddress: USER_WALLET,
      status: 'retry_pending',
      attemptCount: 1,
    })
    mockServer.loadAccount
      .mockResolvedValueOnce(makeHorizonAccount(USER_WALLET, [{ asset_type: 'native', balance: '0.0000000' }]))
      .mockResolvedValueOnce(makeHorizonAccount(SPONSOR_WALLET, [{ asset_type: 'native', balance: '500.0000000' }]))

    mockServer.submitTransaction.mockResolvedValueOnce({
      hash: 'sponsored-trustline-tx-1',
    })
    mockPrisma.trustlineBootstrap.upsert.mockImplementationOnce(async ({ update }) => ({
      id: 'sentinel-1',
      walletAddress: USER_WALLET,
      ...update,
    }))

    const res = await POST(makePostRequest())
    expect(res.status).toBe(201)
    const body = await res.json()

    expect(body.bootstrapped).toBe(true)
    expect(body.txHash).toBe('sponsored-trustline-tx-1')
    expect(body.attemptCount).toBe(2)

    // Verify submitted transaction contains the 3-op sponsored reserve sandwich
    const submittedTx = mockServer.submitTransaction.mock.calls[0][0]
    expect(submittedTx.operations).toHaveLength(3)
    expect(submittedTx.operations[0].type).toBe('beginSponsoringFutureReserves')
    expect(submittedTx.operations[1].type).toBe('changeTrust')
    expect(submittedTx.operations[2].type).toBe('endSponsoringFutureReserves')
  })
})
