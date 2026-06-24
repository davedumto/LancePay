import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('crypto', () => ({
  default: { randomBytes: vi.fn(() => Buffer.from('0102030405060708090a0b0c0d0e0f1011121314', 'hex')) },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { POST } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const userDelegate = prisma.user as unknown as { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
const BASE_URL = 'http://localhost/api/routes-d/auth/2fa/enable'

function makePost(authHeader: string | null = 'Bearer token') {
  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

describe('POST /api/routes-d/auth/2fa/enable', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns 401 when no auth header', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await POST(makePost(null))
    expect(res.status).toBe(401)
  })

  it('returns 401 when token is invalid', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await POST(makePost())
    expect(res.status).toBe(401)
  })

  it('returns 404 when user not found', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    userDelegate.findUnique.mockResolvedValue(null)
    const res = await POST(makePost())
    expect(res.status).toBe(404)
  })

  it('returns 409 when 2FA already enabled', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1', twoFactorEnabled: true })
    const res = await POST(makePost())
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('2FA is already enabled')
  })

  it('returns 200 with twoFactor object on success', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1', twoFactorEnabled: false })
    userDelegate.update.mockResolvedValue({ id: 'user-1', twoFactorEnabled: true })
    const res = await POST(makePost())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.twoFactor).toBeDefined()
    expect(body.twoFactor.enabled).toBe(true)
  })

  it('calls prisma.user.update with twoFactorEnabled true and a secret', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1', twoFactorEnabled: false })
    userDelegate.update.mockResolvedValue({ id: 'user-1', twoFactorEnabled: true })
    await POST(makePost())
    const updateCall = userDelegate.update.mock.calls[0][0]
    expect(updateCall.data.twoFactorEnabled).toBe(true)
    expect(typeof updateCall.data.twoFactorSecret).toBe('string')
    expect(updateCall.data.twoFactorSecret.length).toBeGreaterThan(0)
  })

  it('response contains secret and enabled true', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1', twoFactorEnabled: false })
    userDelegate.update.mockResolvedValue({ id: 'user-1', twoFactorEnabled: true })
    const res = await POST(makePost())
    const body = await res.json()
    expect(body.twoFactor.secret).toMatch(/^[A-Z2-7]+$/)
    expect(body.twoFactor.secret.length).toBeGreaterThan(0)
    expect(body.twoFactor.enabled).toBe(true)
    expect(body.twoFactor.enabledAt).toBeTruthy()
  })
})
