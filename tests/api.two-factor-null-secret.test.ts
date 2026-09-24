import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from '@/app/api/withdrawals/route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    bankAccount: { findFirst: vi.fn() },
    transaction: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}))

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/offramp', () => ({ initiateOfframp: vi.fn() }))
vi.mock('@/lib/stellar', () => ({ getAccountBalance: vi.fn() }))

describe('2FA with enabled flag but missing secret', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects withdrawal when twoFactorEnabled is true and twoFactorSecret is null', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'user-1',
      privyId: 'privy-1',
      wallet: { address: 'G123' },
      twoFactorEnabled: true,
      twoFactorSecret: null,
    } as never)

    const body = { amount: 50, bankAccountId: 'bank-1', code: '123456' }
    const req = new Request('http://localhost/api/withdrawals', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    ;(req as { json: () => Promise<unknown> }).json = async () => body

    const res = await POST(req as never)
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toMatchObject({
      error: '2FA is misconfigured; contact support',
    })
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })
})
