import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('speakeasy', () => ({
  default: {
    totp: {
      verify: vi.fn(),
    },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import speakeasy from 'speakeasy'
import { POST } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedTotp = vi.mocked(speakeasy.totp.verify)
const userDelegate = prisma.user as unknown as { findUnique: ReturnType<typeof vi.fn> }

const BASE_URL = 'http://localhost/api/routes-d/auth/2fa/verify'

function makePost(body: unknown, authHeader: string | null = 'Bearer token') {
  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers: authHeader ? { authorization: authHeader, 'content-type': 'application/json' } : {},
    body: JSON.stringify(body),
  })
}

describe('POST /api/routes-d/auth/2fa/verify', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns 401 when unauthenticated', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await POST(makePost({ code: '123456' }, null))
    expect(res.status).toBe(401)
  })

  it('returns 404 when user not found', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue(null)
    const res = await POST(makePost({ code: '123456' }))
    expect(res.status).toBe(404)
  })

  it('returns 400 when 2FA is not enabled', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({
      id: 'user-1',
      twoFactorEnabled: false,
      twoFactorSecret: null,
    })
    const res = await POST(makePost({ code: '123456' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('not enabled')
  })

  it('returns 400 when code is missing', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({
      id: 'user-1',
      twoFactorEnabled: true,
      twoFactorSecret: 'secret',
    })
    const res = await POST(makePost({}))
    expect(res.status).toBe(400)
  })

  it('returns 401 when code is invalid', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({
      id: 'user-1',
      twoFactorEnabled: true,
      twoFactorSecret: 'secret',
    })
    mockedTotp.mockReturnValue(false)
    const res = await POST(makePost({ code: '000000' }))
    expect(res.status).toBe(401)
  })

  it('returns 200 when code is valid', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({
      id: 'user-1',
      twoFactorEnabled: true,
      twoFactorSecret: 'secret',
    })
    mockedTotp.mockReturnValue(true)
    const res = await POST(makePost({ code: '123456' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
  })
})
