import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from '@/app/api/withdrawals/route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { initiateOfframp } from '@/lib/offramp'
import { getAccountBalance } from '@/lib/stellar'

// Mock dependencies
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    bankAccount: { findFirst: vi.fn() },
    transaction: { create: vi.fn() },
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
}))

vi.mock('@/lib/crypto', () => ({
  decrypt: vi.fn().mockReturnValue('decrypted_secret'),
}))

describe('Withdrawal API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const makeRequest = (body: any) => {
    const req = new Request('http://localhost:3000/api/withdrawals', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'authorization': 'Bearer test-token' 
      },
      body: JSON.stringify(body),
    })
    // Mock .json() because standard Request in Node might need it
    req.json = async () => body;
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
    vi.mocked(initiateOfframp).mockResolvedValue({ transactionId: 'ext-tx-123', status: 'pending' })
    vi.mocked(prisma.transaction.create).mockResolvedValue({ id: 'internal-tx-123', status: 'pending' } as any)

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
    vi.mocked(initiateOfframp).mockRejectedValue(new Error('API Down'))

    const res = await POST(makeRequest({ amount: 50, bankAccountId: 'bank-1' }))
    const json = await res.json()

    expect(res.status).toBe(500)
    expect(json.error).toBe('API Down')
  })
})
