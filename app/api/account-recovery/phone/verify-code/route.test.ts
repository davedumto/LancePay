import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    recoveryPhoneVerification: { findFirst: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { phoneRecoveryVerifyLimiter, POST } from './route'

const mockVerification = {
  id: 'verification-1',
  userId: 'user-1',
  phone: '+15551234567',
  code: '123456',
  expiresAt: new Date(Date.now() + 60_000),
  verified: false,
}

function makeRequest(body: unknown = { code: '123456' }): NextRequest {
  return new NextRequest('http://localhost/api/account-recovery/phone/verify-code', {
    method: 'POST',
    headers: { authorization: 'Bearer token' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  phoneRecoveryVerifyLimiter.reset('verification-1')
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as any)
  vi.mocked(prisma.recoveryPhoneVerification.findFirst).mockResolvedValue(mockVerification as any)
  vi.mocked(prisma.$transaction).mockImplementation((async (callback: any) => callback({
    recoveryPhoneVerification: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn(),
    },
    user: { update: vi.fn() },
  })) as any)
})

describe('POST /api/account-recovery/phone/verify-code', () => {
  it('verifies a valid code and updates the recovery phone', async () => {
    const response = await POST(makeRequest())

    expect(response.status).toBe(200)
    expect(prisma.recoveryPhoneVerification.findFirst).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      orderBy: { createdAt: 'desc' },
    })
    expect(prisma.$transaction).toHaveBeenCalledOnce()
  })

  it('rejects a code consumed by a concurrent request', async () => {
    vi.mocked(prisma.$transaction).mockImplementation((async (callback: any) => callback({
      recoveryPhoneVerification: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUnique: vi.fn().mockResolvedValue({ verified: true, expiresAt: mockVerification.expiresAt }),
      },
      user: { update: vi.fn() },
    })) as any)

    const response = await POST(makeRequest())
    expect(response.status).toBe(409)
  })

  it('rejects an expired code distinctly', async () => {
    vi.mocked(prisma.recoveryPhoneVerification.findFirst).mockResolvedValue({
      ...mockVerification,
      expiresAt: new Date(Date.now() - 1),
    } as any)

    const response = await POST(makeRequest())
    expect(response.status).toBe(410)
    expect((await response.json()).error).toContain('expired')
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('rejects a code that has already been verified', async () => {
    vi.mocked(prisma.recoveryPhoneVerification.findFirst).mockResolvedValue({
      ...mockVerification,
      verified: true,
    } as any)

    const response = await POST(makeRequest())
    expect(response.status).toBe(409)
    expect((await response.json()).error).toContain('already')
  })

  it('limits incorrect attempts per verification record', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await POST(makeRequest({ code: '000000' }))).status).toBe(400)
    }

    const response = await POST(makeRequest({ code: '000000' }))
    expect(response.status).toBe(429)
  })

  it('rejects an invalid code without consuming it', async () => {
    const response = await POST(makeRequest({ code: '000000' }))
    expect(response.status).toBe(400)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })
})