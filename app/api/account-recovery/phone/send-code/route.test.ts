import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockPrisma = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
  },
  recoveryPhoneVerification: {
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
    create: vi.fn(),
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
  MAX_PHONE_SENDS_PER_WINDOW,
  PHONE_CODE_TTL_MS,
  resetPhoneSendRateLimitState,
} from './route'

describe('POST /api/account-recovery/phone/send-code', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetPhoneSendRateLimitState()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'did:privy:user_send_1' })
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user_send_1' })
    mockPrisma.recoveryPhoneVerification.updateMany.mockResolvedValue({
      count: 1,
    })
    mockPrisma.recoveryPhoneVerification.deleteMany.mockResolvedValue({
      count: 1,
    })
  })

  it('generates a short numeric code with bounded expiresAt, invalidates prior unverified codes, and never returns the raw code in the response', async () => {
    let persistedCode = ''
    mockPrisma.recoveryPhoneVerification.create.mockImplementation(
      async ({ data }: { data: Record<string, any> }) => {
        persistedCode = data.code
        return {
          id: 'ver_new_1',
          ...data,
          createdAt: new Date(),
        }
      },
    )

    const beforeMs = Date.now()
    const req = new NextRequest(
      'http://localhost/api/account-recovery/phone/send-code',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          phone: '+14155550199',
        }),
      },
    )

    const res = await POST(req)
    expect(res.status).toBe(201)
    const body = await res.json()

    // 1. Short 6-digit numeric code persisted in DB
    expect(persistedCode).toMatch(/^\d{6}$/)

    // 2. Bounded expiresAt (~10 minutes from now)
    const expiresAtMs = new Date(body.expiresAt).getTime()
    expect(expiresAtMs).toBeGreaterThanOrEqual(
      beforeMs + PHONE_CODE_TTL_MS - 1000,
    )
    expect(expiresAtMs).toBeLessThanOrEqual(
      Date.now() + PHONE_CODE_TTL_MS + 1000,
    )

    // 3. Raw code is NEVER exposed in the HTTP response
    expect(body.code).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain(persistedCode)

    // 4. Prior unverified codes for the user were invalidated before creating the new code
    expect(
      mockPrisma.recoveryPhoneVerification.updateMany,
    ).toHaveBeenCalledWith({
      where: { userId: 'user_send_1', verified: false },
      data: { expiresAt: new Date(0) },
    })
    expect(
      mockPrisma.recoveryPhoneVerification.deleteMany,
    ).toHaveBeenCalledWith({
      where: { userId: 'user_send_1', verified: false },
    })
    expect(body.invalidatedPriorCount).toBe(1)
  })

  it('rate-limits how often a new code can be requested for the same user or phone number to prevent SMS abuse', async () => {
    mockPrisma.recoveryPhoneVerification.create.mockImplementation(
      async ({ data }: { data: Record<string, any> }) => ({
        id: 'ver_rate_1',
        ...data,
        createdAt: new Date(),
      }),
    )

    for (let i = 0; i < MAX_PHONE_SENDS_PER_WINDOW; i++) {
      const okReq = new NextRequest(
        'http://localhost/api/account-recovery/phone/send-code',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer valid_token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ phone: '+14155550199' }),
        },
      )
      const okRes = await POST(okReq)
      expect(okRes.status).toBe(201)
    }

    // 4th request within the window for the same user/phone is rejected with 429
    const throttledReq = new NextRequest(
      'http://localhost/api/account-recovery/phone/send-code',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ phone: '+14155550199' }),
      },
    )
    const throttledRes = await POST(throttledReq)
    expect(throttledRes.status).toBe(429)
    expect(throttledRes.headers.get('Retry-After')).toBeTruthy()
    const throttledBody = await throttledRes.json()
    expect(throttledBody.code).toBe('PHONE_VERIFICATION_RATE_LIMITED')

    // Also rate-limited if a different user targets the same phone number
    mockPrisma.user.findUnique.mockResolvedValueOnce({ id: 'user_send_2' })
    const samePhoneDiffUserReq = new NextRequest(
      'http://localhost/api/account-recovery/phone/send-code',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ phone: '+14155550199' }),
      },
    )
    const samePhoneRes = await POST(samePhoneDiffUserReq)
    expect(samePhoneRes.status).toBe(429)
  })
})
