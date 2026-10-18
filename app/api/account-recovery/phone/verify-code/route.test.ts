import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockPrisma = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
  },
  recoveryPhoneVerification: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
  },
}))

const mockVerifyAuthToken = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  POST,
  MAX_VERIFY_ATTEMPTS_PER_RECORD,
  resetPhoneVerifyAttemptState,
} from './route'

describe('POST /api/account-recovery/phone/verify-code', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetPhoneVerifyAttemptState()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'did:privy:user_rec_1' })
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user_rec_1' })
  })

  it('rejects an expired code with a distinct expired response', async () => {
    mockPrisma.recoveryPhoneVerification.findUnique.mockResolvedValue({
      id: 'ver_expired_1',
      userId: 'user_rec_1',
      phone: '+14155550100',
      code: '482910',
      expiresAt: new Date(Date.now() - 60_000),
      verified: false,
      createdAt: new Date(Date.now() - 600_000),
    })

    const req = new NextRequest(
      'http://localhost/api/account-recovery/phone/verify-code',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          verificationId: 'ver_expired_1',
          code: '482910',
        }),
      },
    )

    const res = await POST(req)
    expect(res.status).toBe(410)
    const body = await res.json()
    expect(body).toMatchObject({
      code: 'VERIFICATION_CODE_EXPIRED',
      expired: true,
    })
    expect(
      mockPrisma.recoveryPhoneVerification.updateMany,
    ).not.toHaveBeenCalled()
  })

  it('consumes a valid code once and rejects a code that has already been marked verified', async () => {
    mockPrisma.recoveryPhoneVerification.findUnique.mockResolvedValueOnce({
      id: 'ver_active_1',
      userId: 'user_rec_1',
      phone: '+14155550100',
      code: '739204',
      expiresAt: new Date(Date.now() + 300_000),
      verified: false,
      createdAt: new Date(),
    })
    mockPrisma.recoveryPhoneVerification.updateMany.mockResolvedValueOnce({
      count: 1,
    })

    const firstReq = new NextRequest(
      'http://localhost/api/account-recovery/phone/verify-code',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          verificationId: 'ver_active_1',
          code: '739204',
        }),
      },
    )

    const firstRes = await POST(firstReq)
    expect(firstRes.status).toBe(200)
    const firstBody = await firstRes.json()
    expect(firstBody).toEqual({
      verified: true,
      verificationId: 'ver_active_1',
      userId: 'user_rec_1',
      phone: '+14155550100',
    })
    expect(
      mockPrisma.recoveryPhoneVerification.updateMany,
    ).toHaveBeenCalledWith({
      where: { id: 'ver_active_1', verified: false },
      data: { verified: true },
    })

    // Second attempt on an already-verified record is rejected with 409
    mockPrisma.recoveryPhoneVerification.findUnique.mockResolvedValueOnce({
      id: 'ver_active_1',
      userId: 'user_rec_1',
      phone: '+14155550100',
      code: '739204',
      expiresAt: new Date(Date.now() + 300_000),
      verified: true,
      createdAt: new Date(),
    })

    const replayReq = new NextRequest(
      'http://localhost/api/account-recovery/phone/verify-code',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          verificationId: 'ver_active_1',
          code: '739204',
        }),
      },
    )

    const replayRes = await POST(replayReq)
    expect(replayRes.status).toBe(409)
    const replayBody = await replayRes.json()
    expect(replayBody).toMatchObject({
      code: 'VERIFICATION_CODE_ALREADY_USED',
      alreadyVerified: true,
    })
  })

  it('rate-limits verification attempts per verification record to prevent brute-forcing', async () => {
    mockPrisma.recoveryPhoneVerification.findUnique.mockResolvedValue({
      id: 'ver_bruteforce_1',
      userId: 'user_rec_1',
      phone: '+14155550100',
      code: '999999',
      expiresAt: new Date(Date.now() + 300_000),
      verified: false,
      createdAt: new Date(),
    })

    for (let i = 0; i < MAX_VERIFY_ATTEMPTS_PER_RECORD; i++) {
      const wrongReq = new NextRequest(
        'http://localhost/api/account-recovery/phone/verify-code',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer valid_token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            verificationId: 'ver_bruteforce_1',
            code: `10000${i}`,
          }),
        },
      )
      const wrongRes = await POST(wrongReq)
      expect(wrongRes.status).toBe(400)
      const wrongBody = await wrongRes.json()
      expect(wrongBody.code).toBe('INVALID_VERIFICATION_CODE')
    }

    // Next attempt (even with the right code) is blocked with 429
    const blockedReq = new NextRequest(
      'http://localhost/api/account-recovery/phone/verify-code',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          verificationId: 'ver_bruteforce_1',
          code: '999999',
        }),
      },
    )
    const blockedRes = await POST(blockedReq)
    expect(blockedRes.status).toBe(429)
    const blockedBody = await blockedRes.json()
    expect(blockedBody.code).toBe('VERIFICATION_ATTEMPTS_EXCEEDED')
    expect(
      mockPrisma.recoveryPhoneVerification.updateMany,
    ).not.toHaveBeenCalled()
  })
})
