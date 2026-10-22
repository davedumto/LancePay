import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { Horizon, Keypair, Account } from '@stellar/stellar-sdk'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    trustlineBootstrap: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
  },
}))

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}))

const { mockLoadAccount, mockSubmitTransaction } = vi.hoisted(() => ({
  mockLoadAccount: vi.fn(),
  mockSubmitTransaction: vi.fn(),
}))

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>()
  class MockServer {
    loadAccount = mockLoadAccount
    submitTransaction = mockSubmitTransaction
  }
  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: MockServer,
    },
  }
})

describe('POST /api/stellar/trustlines/usdc/bootstrap', () => {
  const validWallet = Keypair.random().publicKey()
  const sponsorKey = Keypair.random()

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.STELLAR_SPONSOR_SECRET = sponsorKey.secret()
  })

  function makeRequest(body: unknown, token = 'user-token') {
    return new NextRequest('http://localhost:3000/api/stellar/trustlines/usdc/bootstrap', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  }

  function setupAuth() {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_123' } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'user_1',
      email: 'user@example.com',
    } as any)
  }

  it('submits sponsored change trust operation and marks bootstrap success', async () => {
    setupAuth()

    vi.mocked(prisma.trustlineBootstrap.findUnique).mockResolvedValue(null)
    mockLoadAccount.mockImplementation(async (pubKey) => {
      if (pubKey === validWallet) {
        return { balances: [{ asset_type: 'native', balance: '0' }] }
      }
      return new Account(sponsorKey.publicKey(), '100')
    })

    vi.mocked(prisma.trustlineBootstrap.upsert).mockResolvedValue({
      id: 'tb_sentinel_1',
      walletAddress: validWallet,
      retryCount: 0,
    } as any)

    mockSubmitTransaction.mockResolvedValue({
      hash: 'mock_tx_hash_123',
    })

    vi.mocked(prisma.trustlineBootstrap.update).mockResolvedValue({
      id: 'tb_1',
      status: 'success',
      txHash: 'mock_tx_hash_123',
    } as any)

    const req = makeRequest({ walletAddress: validWallet })
    const res = await POST(req)
    const json = await res.json()

    expect(res.status).toBe(201)
    expect(json.success).toBe(true)
    expect(json.txHash).toBe('mock_tx_hash_123')
    expect(prisma.trustlineBootstrap.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { walletAddress: validWallet },
        data: expect.objectContaining({ status: 'success' }),
      }),
    )
  })

  it('rejects wallets that already carry an active USDC trustline (from DB)', async () => {
    setupAuth()

    vi.mocked(prisma.trustlineBootstrap.findUnique).mockResolvedValue({
      id: 'tb_existing',
      walletAddress: validWallet,
      status: 'success',
      txHash: 'existing_hash_99',
    } as any)

    const req = makeRequest({ walletAddress: validWallet })
    const res = await POST(req)
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.code).toBe('TRUSTLINE_ALREADY_EXISTS')
    expect(mockSubmitTransaction).not.toHaveBeenCalled()
  })

  it('rejects wallets that already carry an active USDC trustline on Horizon', async () => {
    setupAuth()

    vi.mocked(prisma.trustlineBootstrap.findUnique).mockResolvedValue(null)
    mockLoadAccount.mockResolvedValue({
      balances: [
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          balance: '50.0',
        },
      ],
    })

    const req = makeRequest({ walletAddress: validWallet })
    const res = await POST(req)
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.code).toBe('TRUSTLINE_ALREADY_EXISTS')
    expect(mockSubmitTransaction).not.toHaveBeenCalled()
  })

  it('treats Horizon submission failure as retryable and leaves an idempotent sentinel', async () => {
    setupAuth()

    vi.mocked(prisma.trustlineBootstrap.findUnique).mockResolvedValue(null)
    mockLoadAccount.mockImplementation(async (pubKey) => {
      if (pubKey === validWallet) {
        return { balances: [{ asset_type: 'native', balance: '0' }] }
      }
      return new Account(sponsorKey.publicKey(), '100')
    })

    vi.mocked(prisma.trustlineBootstrap.upsert).mockResolvedValue({
      id: 'tb_sentinel_1',
      walletAddress: validWallet,
      retryCount: 0,
    } as any)

    mockSubmitTransaction.mockRejectedValue(new Error('Horizon connection timeout'))

    const req = makeRequest({ walletAddress: validWallet })
    const res = await POST(req)
    const json = await res.json()

    expect(res.status).toBe(503)
    expect(json.code).toBe('HORIZON_SUBMISSION_RETRYABLE')
    expect(json.retryable).toBe(true)
    expect(prisma.trustlineBootstrap.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { walletAddress: validWallet },
        data: expect.objectContaining({ status: 'retryable_failure' }),
      }),
    )
  })

  it('rejects invalid Stellar public key with 400', async () => {
    setupAuth()

    const req = makeRequest({ walletAddress: 'not-a-valid-stellar-key' })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('returns 401 when request is unauthenticated', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)

    const req = makeRequest({ walletAddress: validWallet }, '')
    const res = await POST(req)
    expect(res.status).toBe(401)
  })

  it('returns 500 when database throws', async () => {
    setupAuth()
    vi.mocked(prisma.trustlineBootstrap.findUnique).mockRejectedValue(new Error('DB failure'))

    const req = makeRequest({ walletAddress: validWallet })
    const res = await POST(req)
    expect(res.status).toBe(500)
  })
})
