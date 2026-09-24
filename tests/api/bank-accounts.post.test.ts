import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from '@/app/api/bank-accounts/route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { verifyNigerianBankAccount } from '@/lib/bank-verification'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    bankAccount: { findFirst: vi.fn(), count: vi.fn(), create: vi.fn() },
  },
}))

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/bank-verification', () => ({
  verifyNigerianBankAccount: vi.fn(),
}))

vi.mock('@/lib/crypto', () => ({
  decrypt: vi.fn().mockReturnValue('decrypted_secret'),
}))

vi.mock('@/lib/rate-limit', () => ({
  twoFactorLimiter: { check: vi.fn().mockReturnValue({ allowed: true }) },
  buildRateLimitResponse: vi.fn(),
}))

const mockUser = { id: 'user-1', privyId: 'privy-1', twoFactorEnabled: false }

function makeRequest(body: string | object) {
  return new Request('http://localhost/api/bank-accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer valid-token' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest
}

describe('POST /api/bank-accounts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as never)
    vi.mocked(verifyNigerianBankAccount).mockResolvedValue({
      valid: true,
      accountNumber: '0123456789',
      accountName: 'Ada Lovelace',
    } as never)
    vi.mocked(prisma.bankAccount.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.bankAccount.count).mockResolvedValue(0)
    vi.mocked(prisma.bankAccount.create).mockImplementation(
      (async ({ data }: { data: object }) => ({ id: 'bank-1', ...data })) as never,
    )
  })

  it('creates a bank account for a valid payload', async () => {
    const res = await POST(makeRequest({ bankCode: '058', accountNumber: '0123456789' }))

    expect(res.status).toBe(201)
    expect(verifyNigerianBankAccount).toHaveBeenCalledWith('0123456789', '058')
    expect(prisma.bankAccount.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ bankCode: '058', bankName: 'Guaranty Trust Bank', isDefault: true }),
    })
  })

  it.each([
    ['bankCode', { bankCode: 'ABC', accountNumber: '0123456789' }, 'Bank code must be 3 digits'],
    ['bankCode', { bankCode: '0580', accountNumber: '0123456789' }, 'Bank code must be 3 digits'],
    ['accountNumber', { bankCode: '058', accountNumber: '01234abcde' }, 'Account number must be 10 digits'],
    ['accountNumber', { bankCode: '058', accountNumber: '12345' }, 'Account number must be 10 digits'],
    ['accountNumber', { bankCode: '058', accountNumber: 123456789 }, 'Expected string, received number'],
    ['bankCode', { accountNumber: '0123456789' }, 'Required'],
  ])('rejects a malformed %s using addBankAccountSchema', async (field, body, message) => {
    const res = await POST(makeRequest(body))
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.error).toBe('Invalid request body')
    expect(json.details[field]).toEqual([message])
    expect(verifyNigerianBankAccount).not.toHaveBeenCalled()
    expect(prisma.bankAccount.create).not.toHaveBeenCalled()
  })

  it('returns 400 for a malformed JSON body', async () => {
    const res = await POST(makeRequest('{not json'))

    expect(res.status).toBe(400)
    expect(prisma.bankAccount.create).not.toHaveBeenCalled()
  })

  it('still rejects a well-formed but unknown bank code', async () => {
    const res = await POST(makeRequest({ bankCode: '999', accountNumber: '0123456789' }))
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.error).toBe('Invalid bank code')
    expect(prisma.bankAccount.create).not.toHaveBeenCalled()
  })

  it('returns 401 when 2FA code is missing but required', async () => {
    const userWith2FA = { ...mockUser, twoFactorEnabled: true, twoFactorSecret: 'encrypted_secret' }
    vi.mocked(prisma.user.findUnique).mockResolvedValue(userWith2FA as never)

    const res = await POST(makeRequest({ bankCode: '058', accountNumber: '0123456789' }))
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

    const userWith2FA = { ...mockUser, twoFactorEnabled: true, twoFactorSecret: 'encrypted_secret' }
    vi.mocked(prisma.user.findUnique).mockResolvedValue(userWith2FA as never)

    const res = await POST(makeRequest({ bankCode: '058', accountNumber: '0123456789', code: '123456' }))
    
    expect(res.status).toBe(429)
  })
})
