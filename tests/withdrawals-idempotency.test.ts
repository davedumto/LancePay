import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { POST, __clearWithdrawalIdempotencyCache } from '@/app/api/withdrawals/route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { initiateOfframp } from '@/lib/offramp'
import { getAccountBalance, debitDelegatedUSDC } from '@/lib/stellar'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    bankAccount: { findFirst: vi.fn() },
    transaction: { create: vi.fn(), findUnique: vi.fn() },
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

describe('Withdrawal idempotency (#1517)', () => {
  const makeRequest = (body: any) => {
    const req = new Request('http://localhost:3000/api/withdrawals', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: 'Bearer test-token',
      },
      body: JSON.stringify(body),
    })
    req.json = async () => body
    return req as never
  }

  beforeEach(() => {
    vi.clearAllMocks()
    __clearWithdrawalIdempotencyCache()
    process.env.WITHDRAWAL_DELEGATE_SECRET_KEY = 'test-delegate-secret'
    process.env.TREASURY_WALLET_ADDRESS = 'GTREASURYTEST'

    const mockUser = {
      id: 'user-1',
      privyId: 'privy-1',
      wallet: { address: 'G123' },
      twoFactorEnabled: false,
    }
    const mockBankAccount = {
      id: 'bank-1',
      accountNumber: '1234567890',
      bankCode: '001',
      accountName: 'John Doe',
    }

    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
    vi.mocked(prisma.bankAccount.findFirst).mockResolvedValue(mockBankAccount as any)
    vi.mocked(getAccountBalance).mockResolvedValue([
      { asset_code: 'USDC', balance: '100.0' },
    ] as any)
    vi.mocked(debitDelegatedUSDC).mockResolvedValue('tx-hash-1' as any)
    vi.mocked(initiateOfframp).mockResolvedValue({
      transactionId: 'ext-tx-123',
      status: 'pending',
    } as any)
    vi.mocked((prisma.transaction as any).findUnique).mockResolvedValue(null)
    vi.mocked(prisma.transaction.create).mockResolvedValue({
      id: 'internal-tx-123',
      status: 'pending',
    } as any)
  })

  it('creates only one withdrawal for a rapid double-click with the same idempotency key', async () => {
    const payload = { amount: 50, bankAccountId: 'bank-1', idempotencyKey: 'key-double-click-1' }

    // Simulate two concurrent POSTs from a double-click carrying the same key
    const [first, second] = await Promise.all([POST(makeRequest(payload)), POST(makeRequest(payload))])
    const firstJson = await first.json()
    const secondJson = await second.json()

    // Exactly one real withdrawal is created ...
    expect(prisma.transaction.create).toHaveBeenCalledTimes(1)
    // ... the first request succeeds ...
    expect(first.status).toBe(201)
    expect(firstJson.transactionId).toBe('internal-tx-123')
    // ... and the duplicate is a no-op that never touches the money path again
    expect([200, 409]).toContain(second.status)
    expect(initiateOfframp).toHaveBeenCalledTimes(1)
    if (second.status === 200) {
      expect(secondJson.transactionId).toBe(firstJson.transactionId)
    }
  })

  it('returns the existing withdrawal when the same idempotency key is reused', async () => {
    const payload = { amount: 50, bankAccountId: 'bank-1', idempotencyKey: 'key-reuse-1' }

    const first = await POST(makeRequest(payload))
    expect(first.status).toBe(201)

    const second = await POST(makeRequest(payload))
    const secondJson = await second.json()

    expect(second.status).toBe(200)
    expect(secondJson.transactionId).toBe('internal-tx-123')
    expect(prisma.transaction.create).toHaveBeenCalledTimes(1)
  })

  it('guards the withdraw button with isSubmitting and sends an idempotency key', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'app/(dashboard)/dashboard/withdrawals/page.tsx'),
      'utf8',
    )

    // isSubmitting is set before fetch and disables the button while true ...
    expect(source).toContain('isSubmitting')
    expect(source).toMatch(/disabled=\{[^}]*isSubmitting[^}]*\}/)
    // ... reset in a finally block so failures do not wedge the button ...
    expect(source).toMatch(/finally\s*\{[^}]*setIsSubmitting\(false\)/)
    // ... and the request carries an idempotency key for backend dedup.
    expect(source).toContain('idempotencyKey')
  })
})
