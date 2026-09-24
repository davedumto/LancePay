import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PUT } from '@/app/api/user/profile/route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
  },
}))

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/crypto', () => ({
  decrypt: vi.fn().mockReturnValue('decrypted_secret'),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn() },
}))

vi.mock('@/lib/rate-limit', () => ({
  twoFactorLimiter: { check: vi.fn().mockReturnValue({ allowed: true }) },
  buildRateLimitResponse: vi.fn(),
}))

const mockUser = { 
  id: 'user-1', 
  privyId: 'privy-1', 
  email: 'test@example.com',
  name: 'Test User',
  twoFactorEnabled: false,
}

function makeRequest(body: object) {
  return new Request('http://localhost/api/user/profile', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer valid-token' },
    body: JSON.stringify(body),
  })
}

describe('PUT /api/user/profile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as never)
    vi.mocked(prisma.user.update).mockImplementation(
      (async ({ data }: { data: object }) => ({ id: 'user-1', ...mockUser, ...data })) as never,
    )
  })

  it('updates profile for valid payload', async () => {
    const res = await PUT(makeRequest({ name: 'New Name', phone: '+1234567890' }))

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.name).toBe('New Name')
    expect(json.phone).toBe('+1234567890')
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { privyId: 'privy-1' },
      data: expect.objectContaining({ name: 'New Name', phone: '+1234567890' }),
    })
  })

  it('returns 400 for invalid taxPercentage', async () => {
    const res = await PUT(makeRequest({ taxPercentage: 150 }))
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.error).toBe('taxPercentage must be between 0 and 100')
  })

  it('returns 401 when 2FA code is missing but required', async () => {
    const userWith2FA = { ...mockUser, twoFactorEnabled: true, twoFactorSecret: 'encrypted_secret' }
    vi.mocked(prisma.user.findUnique).mockResolvedValue(userWith2FA as never)

    const res = await PUT(makeRequest({ name: 'New Name' }))
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

    const res = await PUT(makeRequest({ name: 'New Name', code: '123456' }))
    
    expect(res.status).toBe(429)
  })
})