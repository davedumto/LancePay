import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ verify: vi.fn() }))

vi.mock('@privy-io/server-auth', () => ({
  PrivyClient: class {
    verifyAuthToken = mocks.verify
  },
}))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    userSession: { upsert: vi.fn() },
  },
}))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUserFind = prisma.user.findUnique as unknown as ReturnType<typeof vi.fn>
const mockSessionUpsert = prisma.userSession.upsert as unknown as ReturnType<typeof vi.fn>

describe('verifyAuthToken session revocation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.verify.mockResolvedValue({ userId: 'privy-user', sessionId: 'session-1' })
    mockUserFind.mockResolvedValue({ id: 'user-1' })
    mockSessionUpsert.mockResolvedValue({ userId: 'user-1', revokedAt: null })
  })

  it('accepts and registers an active verified session', async () => {
    await expect(verifyAuthToken('token')).resolves.toMatchObject({ sessionId: 'session-1' })
    expect(mockSessionUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { providerSessionId: 'session-1' },
      create: expect.objectContaining({ userId: 'user-1' }),
      update: expect.objectContaining({ lastSeenAt: expect.any(Date) }),
    }))
  })

  it('rejects a revoked session on the authentication path', async () => {
    mockSessionUpsert.mockResolvedValue({ userId: 'user-1', revokedAt: new Date() })
    await expect(verifyAuthToken('token')).resolves.toBeNull()
  })
})
describe('verifyAuthToken missing-user handling (#1836)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.verify.mockResolvedValue({ userId: 'privy-user', sessionId: 'session-1' })
    mockSessionUpsert.mockResolvedValue({ userId: 'user-1', revokedAt: null })
  })

  it('rejects a verified token when no local User row exists', async () => {
    mockUserFind.mockResolvedValue(null)
    await expect(verifyAuthToken('token')).resolves.toBeNull()
    expect(mockSessionUpsert).not.toHaveBeenCalled()
  })

  it('rejects a token for a deleted user even if a session row exists', async () => {
    mockUserFind.mockResolvedValue(null)
    mockSessionUpsert.mockResolvedValue({ userId: 'user-1', revokedAt: null })
    await expect(verifyAuthToken('token')).resolves.toBeNull()
    // user lookup happens before the session upsert, so revocation state is moot
    expect(mockSessionUpsert).not.toHaveBeenCalled()
  })

  it('still rejects a revoked session for an existing user', async () => {
    mockUserFind.mockResolvedValue({ id: 'user-1' })
    mockSessionUpsert.mockResolvedValue({ userId: 'user-1', revokedAt: new Date() })
    await expect(verifyAuthToken('token')).resolves.toBeNull()
  })

  it('verifyAuthTokenForProvisioning allows a missing user for first-login routes', async () => {
    const { verifyAuthTokenForProvisioning } = await import('@/lib/auth')
    mockUserFind.mockResolvedValue(null)
    await expect(verifyAuthTokenForProvisioning('token')).resolves.toMatchObject({
      userId: 'privy-user',
      sessionId: 'session-1',
    })
    expect(mockSessionUpsert).not.toHaveBeenCalled()
  })

  it('verifyAuthTokenForProvisioning still enforces revocation for existing users', async () => {
    const { verifyAuthTokenForProvisioning } = await import('@/lib/auth')
    mockUserFind.mockResolvedValue({ id: 'user-1' })
    mockSessionUpsert.mockResolvedValue({ userId: 'user-1', revokedAt: new Date() })
    await expect(verifyAuthTokenForProvisioning('token')).resolves.toBeNull()
  })
})
