import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from '@/app/api/withdrawals/route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { initiateOfframp } from '@/lib/offramp'
import { getAccountBalance, debitDelegatedUSDC } from '@/lib/stellar'
import { NextRequest } from 'next/server'

// Mock dependencies
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    bankAccount: { findFirst: vi.fn() },
    transaction: { create: vi.fn() },
    withdrawalTransaction: { create: vi.fn() },
  },
}))

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/offramp', () => ({
  initiateOfframp: vi.fn(),
}))

vi.mock('@/lib/stellar', () => ({
  getAccountBalance: vi.fn(),
  debitDelegatedUSDC: vi.fn(),
}))

vi.mock('@/lib/crypto', () => ({
  decrypt: vi.fn().mockReturnValue('decrypted_secret'),
}))

vi.mock('@/lib/rate-limit', () => ({
  twoFactorLimiter: { check: vi.fn().mockReturnValue({ allowed: true }) },
  buildRateLimitResponse: vi.fn(),
}))

describe('Withdrawal API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.WITHDRAWAL_DELEGATE_SECRET_KEY = 'SDELEGATESECRET'
    process.env.TREASURY_WALLET_ADDRESS = 'GTREASURYADDRESS'
  })

  const makeRequest = (body: any) => {
    const req = new NextRequest('http://localhost:3000/api/withdrawals', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'authorization': 'Bearer test-token' 
      },
      body: JSON.stringify(body),
    })
    return req
  }

  it('successfully initiates a withdrawal', async () => {
    const mockUser = { 
      id: 'user-1', 
      privyId: 'privy-1', 
      wallet: { address: 'G123' }, 
      twoFactorEnabled: false 
    }
    const mockBankAccount = { 
      id: 'bank-1', 
      accountNumber: '1234567890', 
      bankCode: '001', 
      accountName: 'John Doe' 
    }
    
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
    vi.mocked(prisma.bankAccount.findFirst).mockResolvedValue(mockBankAccount as any)
    vi.mocked(getAccountBalance).mockResolvedValue([{ asset_code: 'USDC', balance: '100.0' }] as any)
    vi.mocked(debitDelegatedUSDC).mockResolvedValue('tx-hash-real')
    vi.mocked(initiateOfframp).mockResolvedValue({ transactionId: 'ext-tx-123', status: 'pending' })
    vi.mocked(prisma.transaction.create).mockResolvedValue({ id: 'internal-tx-123', status: 'pending' } as any)
    vi.mocked(prisma.withdrawalTransaction.create).mockResolvedValue({ id: 'wd-tx-123', status: 'pending' } as any)

    const res = await POST(makeRequest({ amount: 50, bankAccountId: 'bank-1' }))
    const json = await res.json()

    expect(res.status).toBe(201)
    expect(json.transactionId).toBe('internal-tx-123')
    expect(json.message).toBe('Withdrawal initiated')
    
    // Verify initiateOfframp was called with correct params
    expect(initiateOfframp).toHaveBeenCalledWith(expect.objectContaining({
      amount: 50,
      bankAccount: expect.objectContaining({
        accountNumber: '1234567890',
        bankCode: '001'
      })
    }))

    // Verify transaction was recorded in DB
    expect(prisma.transaction.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        userId: 'user-1',
        externalId: 'ext-tx-123',
        amount: 50,
        status: 'pending'
      })
    }))

    // Verify WithdrawalTransaction was created for webhook tracking
    expect(prisma.withdrawalTransaction.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        userId: 'user-1',
        anchorId: 'yellowcard',
        stellarTxId: 'ext-tx-123',
        amount: 50,
        asset: 'USDC',
        status: 'pending',
        withdrawType: 'bank_transfer'
      })
    }))
  })

  it('returns 400 for insufficient balance', async () => {
    const mockUser = { 
      id: 'user-2', 
      privyId: 'privy-2', 
      wallet: { address: 'G456' }, 
      twoFactorEnabled: false 
    }
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-2' } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
    vi.mocked(getAccountBalance).mockResolvedValue([{ asset_code: 'USDC', balance: '10.0' }] as any)
    vi.mocked(prisma.bankAccount.findFirst).mockResolvedValue({ id: 'bank-1' } as any)
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
      const tx = {
        userWithdrawalBalance: {
          upsert: vi.fn().mockResolvedValue({}),
          findUnique: vi.fn().mockResolvedValue({ userId: 'user-2', availableUsdc: 10 }),
          update: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        transaction: { create: vi.fn() },
      }
      return fn(tx as never)
    })

    const res = await POST(makeRequest({ amount: 50, bankAccountId: 'bank-1' }))
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.error).toBe('Insufficient balance')
  })

  it('returns 400 for invalid bank account', async () => {
    const mockUser = { id: 'user-1', privyId: 'privy-1', wallet: { address: 'G123' }, twoFactorEnabled: false }
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
    vi.mocked(getAccountBalance).mockResolvedValue([{ asset_code: 'USDC', balance: '100.0' }] as any)
    vi.mocked(prisma.bankAccount.findFirst).mockResolvedValue(null)

    const res = await POST(makeRequest({ amount: 50, bankAccountId: 'invalid-bank' }))
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.error).toBe('Invalid bank account')
  })

  it('returns 500 if off-ramp API fails', async () => {
    const mockUser = { id: 'user-1', privyId: 'privy-1', wallet: { address: 'G123' }, twoFactorEnabled: false }
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
    vi.mocked(prisma.bankAccount.findFirst).mockResolvedValue({ id: 'bank-1' } as any)
    vi.mocked(getAccountBalance).mockResolvedValue([{ asset_code: 'USDC', balance: '100.0' }] as any)
    vi.mocked(debitDelegatedUSDC).mockResolvedValue('tx-hash-real')
    vi.mocked(initiateOfframp).mockRejectedValue(new Error('API Down'))

    const res = await POST(makeRequest({ amount: 50, bankAccountId: 'bank-1' }))
    const json = await res.json()

    expect(res.status).toBe(500)
    expect(json.error).toBe('API Down')
  })

  it.each([
    ['a non-numeric string', 'abc'],
    ['a numeric string', '50'],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['zero', 0],
    ['a negative number', -10],
  ])('returns a clean 400 for %s amount before touching the database', async (_label, amount) => {
    const mockUser = { id: 'user-1', privyId: 'privy-1', wallet: { address: 'G123' }, twoFactorEnabled: false }
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)

    const res = await POST(makeRequest({ amount, bankAccountId: 'bank-1' }))
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.error).toBe('Invalid amount')
    expect(prisma.bankAccount.findFirst).not.toHaveBeenCalled()
    expect(initiateOfframp).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('returns 401 when 2FA code is missing but required', async () => {
    const mockUser = { 
      id: 'user-1', 
      privyId: 'privy-1', 
      wallet: { address: 'G123' }, 
      twoFactorEnabled: true,
      twoFactorSecret: 'encrypted_secret'
    }
    const mockBankAccount = { 
      id: 'bank-1', 
      accountNumber: '1234567890', 
      bankCode: '001', 
      accountName: 'John Doe' 
    }
    
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
    vi.mocked(prisma.bankAccount.findFirst).mockResolvedValue(mockBankAccount as any)
    vi.mocked(getAccountBalance).mockResolvedValue([{ asset_code: 'USDC', balance: '100.0' }] as any)
    vi.mocked(debitDelegatedUSDC).mockResolvedValue('tx-hash-real')

    const res = await POST(makeRequest({ amount: 50, bankAccountId: 'bank-1' }))
    const json = await res.json()

    expect(res.status).toBe(401)
    expect(json.error).toBe('2FA code required')
  })

  it('returns 429 when 2FA rate limit is exceeded', async () => {
    const { twoFactorLimiter } = await import('@/lib/rate-limit')
    vi.mocked(twoFactorLimiter.check).mockReturnValue({ allowed: false, limit: 5, remaining: 0, resetAt: Date.now() + 15 * 60 * 1000, policyId: '2fa-verify' })
    
    const { buildRateLimitResponse } = await import('@/lib/rate-limit')
    vi.mocked(buildRateLimitResponse).mockImplementation((result) => 
      new Response(JSON.stringify({ error: 'Rate limit exceeded' }), { status: 429 })
    )

    const mockUser = { 
      id: 'user-1', 
      privyId: 'privy-1', 
      wallet: { address: 'G123' }, 
      twoFactorEnabled: true,
      twoFactorSecret: 'encrypted_secret'
    }
    const mockBankAccount = { 
      id: 'bank-1', 
      accountNumber: '1234567890', 
      bankCode: '001', 
      accountName: 'John Doe' 
    }
    
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
    vi.mocked(prisma.bankAccount.findFirst).mockResolvedValue(mockBankAccount as any)
    vi.mocked(getAccountBalance).mockResolvedValue([{ asset_code: 'USDC', balance: '100.0' }] as any)
    vi.mocked(debitDelegatedUSDC).mockResolvedValue('tx-hash-real')

    const res = await POST(makeRequest({ amount: 50, bankAccountId: 'bank-1', code: '123456' }))
    
    expect(res.status).toBe(429)
  })
})
