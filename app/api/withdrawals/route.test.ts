import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    bankAccount: { findFirst: vi.fn() },
    transaction: { create: vi.fn(), findMany: vi.fn() },
    withdrawalTransaction: { create: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/crypto', () => ({ decrypt: vi.fn((v: string) => v) }))
vi.mock('@/lib/offramp', () => ({ initiateOfframp: vi.fn() }))
vi.mock('@/lib/stellar', () => ({
  getAccountBalance: vi.fn(),
  debitDelegatedUSDC: vi.fn(),
}))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { initiateOfframp } from '@/lib/offramp'
import { getAccountBalance, debitDelegatedUSDC } from '@/lib/stellar'

const mockUser = {
  id: 'user-1',
  twoFactorEnabled: false,
  wallet: { address: 'GUSERADDRESS' },
}
const mockClaims = { userId: 'privy-1' }
const mockBankAccount = {
  id: 'bank-1',
  userId: 'user-1',
  accountNumber: '0123456789',
  bankCode: '058',
  accountName: 'Test User',
}

function makeRequest(body?: unknown): NextRequest {
  return new NextRequest('http://localhost/api/withdrawals', {
    method: 'POST',
    headers: { authorization: 'Bearer token' },
    body: body ? JSON.stringify(body) : undefined,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.WITHDRAWAL_DELEGATE_SECRET_KEY = 'SDELEGATESECRET'
  process.env.TREASURY_WALLET_ADDRESS = 'GTREASURYADDRESS'

  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
  vi.mocked(prisma.bankAccount.findFirst).mockResolvedValue(mockBankAccount as any)
  vi.mocked(getAccountBalance).mockResolvedValue([{ asset_code: 'USDC', balance: '100' }] as any)
  vi.mocked(debitDelegatedUSDC).mockResolvedValue('tx-hash-real')
  vi.mocked(initiateOfframp).mockResolvedValue({ transactionId: 'offramp-1' } as any)
  vi.mocked(prisma.transaction.create).mockResolvedValue({
    id: 'txn-1',
    status: 'pending',
  } as any)
  vi.mocked(prisma.withdrawalTransaction.create).mockResolvedValue({
    id: 'wd-1',
    status: 'pending',
  } as any)
})

describe('POST /api/withdrawals', () => {
  it('debits the real on-chain balance and persists the resulting tx hash', async () => {
    const res = await POST(makeRequest({ amount: 50, bankAccountId: 'bank-1' }))
    expect(res.status).toBe(201)
    expect(debitDelegatedUSDC).toHaveBeenCalledWith(
      'SDELEGATESECRET',
      'GUSERADDRESS',
      'GTREASURYADDRESS',
      '50',
      expect.any(String),
    )
    expect(prisma.transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ txHash: 'tx-hash-real' }) }),
    )
  })

  it('does not call the off-ramp provider when the on-chain debit fails', async () => {
    vi.mocked(debitDelegatedUSDC).mockRejectedValue({
      type: 'insufficient_funds',
      message: 'Wallet does not have enough USDC to cover this withdrawal.',
    })
    const res = await POST(makeRequest({ amount: 50, bankAccountId: 'bank-1' }))
    expect(res.status).toBe(400)
    expect(initiateOfframp).not.toHaveBeenCalled()
    expect(prisma.transaction.create).not.toHaveBeenCalled()
  })

  it('rejects a second concurrent withdrawal once the on-chain balance is spent by the first', async () => {
    // Simulate two withdrawals racing for the same 100 USDC balance: the
    // first debit call succeeds and spends the balance, Horizon rejects the
    // second with op_underfunded (surfaced here as insufficient_funds).
    vi.mocked(debitDelegatedUSDC)
      .mockResolvedValueOnce('tx-hash-first')
      .mockRejectedValueOnce({
        type: 'insufficient_funds',
        message: 'Wallet does not have enough USDC to cover this withdrawal.',
      })

    const [first, second] = await Promise.all([
      POST(makeRequest({ amount: 100, bankAccountId: 'bank-1' })),
      POST(makeRequest({ amount: 100, bankAccountId: 'bank-1' })),
    ])

    const statuses = [first.status, second.status].sort()
    expect(statuses).toEqual([201, 400])
    expect(initiateOfframp).toHaveBeenCalledTimes(1)
    expect(prisma.transaction.create).toHaveBeenCalledTimes(1)
  })

  it('returns 502 for a non-balance debit failure instead of a generic 400', async () => {
    vi.mocked(debitDelegatedUSDC).mockRejectedValue({
      type: 'network_error',
      message: 'Horizon unavailable',
    })
    const res = await POST(makeRequest({ amount: 50, bankAccountId: 'bank-1' }))
    expect(res.status).toBe(502)
    expect(initiateOfframp).not.toHaveBeenCalled()
  })

  it('returns 502 when the delegate signer is not configured', async () => {
    delete process.env.WITHDRAWAL_DELEGATE_SECRET_KEY
    const res = await POST(makeRequest({ amount: 50, bankAccountId: 'bank-1' }))
    expect(res.status).toBe(502)
    expect(debitDelegatedUSDC).not.toHaveBeenCalled()
  })

  it('returns 400 for an invalid amount', async () => {
    const res = await POST(makeRequest({ amount: -10, bankAccountId: 'bank-1' }))
    expect(res.status).toBe(400)
    expect(debitDelegatedUSDC).not.toHaveBeenCalled()
  })

  it('returns 400 for an invalid bank account', async () => {
    vi.mocked(prisma.bankAccount.findFirst).mockResolvedValue(null)
    const res = await POST(makeRequest({ amount: 50, bankAccountId: 'missing' }))
    expect(res.status).toBe(400)
    expect(debitDelegatedUSDC).not.toHaveBeenCalled()
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await POST(new NextRequest('http://localhost/api/withdrawals', { method: 'POST' }))
    expect(res.status).toBe(401)
  })

  it('returns 404 when the user record is missing', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    const res = await POST(makeRequest({ amount: 50, bankAccountId: 'bank-1' }))
    expect(res.status).toBe(404)
  })

  it('returns 500 when the off-ramp provider fails after a successful debit', async () => {
    vi.mocked(initiateOfframp).mockRejectedValue(new Error('offramp down'))
    const res = await POST(makeRequest({ amount: 50, bankAccountId: 'bank-1' }))
    expect(res.status).toBe(500)
  })
})
