import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const userUpdate = vi.fn()
const decrypt = vi.fn()
const totpVerify = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique, update: userUpdate },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('@/lib/crypto', () => ({
  decrypt,
  hashToken: (value: string) => `hashed:${value}`,
}))
vi.mock('speakeasy', () => ({
  default: {
    totp: { verify: totpVerify },
  },
}))

const BASE_URL = 'http://localhost/api/routes-d/auth/backup-codes'

function makeRequest(body?: unknown, authHeader: string | null = 'Bearer token') {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (authHeader) headers.set('authorization', authHeader)
  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
  })
}

describe('POST /api/routes-d/auth/backup-codes', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when no authorization header is provided', async () => {
    const { POST } = await import('@/app/api/routes-d/auth/backup-codes/route')
    const res = await POST(makeRequest({}, null))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Unauthorized')
    expect(userFindUnique).not.toHaveBeenCalled()
  })

  it('returns 401 when the auth token is invalid', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-d/auth/backup-codes/route')
    const res = await POST(makeRequest({ code: '123456' }))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Invalid token')
  })

  it('returns 409 when two-factor authentication is not enabled', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({
      id: 'user_1',
      twoFactorEnabled: false,
      twoFactorSecret: null,
    })
    const { POST } = await import('@/app/api/routes-d/auth/backup-codes/route')
    const res = await POST(makeRequest({ code: '123456' }))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toContain('Two-factor authentication must be enabled')
    expect(userUpdate).not.toHaveBeenCalled()
  })

  it('returns 401 when the 2FA code is missing', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({
      id: 'user_1',
      twoFactorEnabled: true,
      twoFactorSecret: 'encrypted-secret',
    })
    const { POST } = await import('@/app/api/routes-d/auth/backup-codes/route')
    const res = await POST(makeRequest({}))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('2FA code required')
  })

  it('returns 401 when the 2FA code is invalid', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({
      id: 'user_1',
      twoFactorEnabled: true,
      twoFactorSecret: 'encrypted-secret',
    })
    decrypt.mockReturnValue('BASE32SECRET')
    totpVerify.mockReturnValue(false)
    const { POST } = await import('@/app/api/routes-d/auth/backup-codes/route')
    const res = await POST(makeRequest({ code: '000000' }))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Invalid 2FA code')
    expect(userUpdate).not.toHaveBeenCalled()
  })

  it('generates backup codes and stores hashed values', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({
      id: 'user_1',
      twoFactorEnabled: true,
      twoFactorSecret: 'encrypted-secret',
    })
    decrypt.mockReturnValue('BASE32SECRET')
    totpVerify.mockReturnValue(true)
    userUpdate.mockResolvedValue({ id: 'user_1' })
    const { POST } = await import('@/app/api/routes-d/auth/backup-codes/route')
    const res = await POST(makeRequest({ code: '123456' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.backupCodes).toHaveLength(10)
    expect(body.count).toBe(10)
    expect(body.generatedAt).toBeTruthy()
    body.backupCodes.forEach((code: string) => {
      expect(code).toMatch(/^[A-Z2-9]{8}$/)
    })
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: 'user_1' },
      data: {
        backupCodes: body.backupCodes.map((code: string) => `hashed:${code}`),
      },
    })
  })

  it('returns 500 on unexpected error', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockRejectedValue(new Error('DB error'))
    const { POST } = await import('@/app/api/routes-d/auth/backup-codes/route')
    const res = await POST(makeRequest({ code: '123456' }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Failed to generate backup codes')
  })
})
