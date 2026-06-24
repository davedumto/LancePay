import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const userUpdate = vi.fn()
const loggerError = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/logger', () => ({ logger: { error: loggerError } }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique, update: userUpdate },
  },
}))

const BASE_URL = 'http://localhost/api/routes-d/auth/2fa'

function makeRequest(opts?: { auth?: string | null }) {
  const authValue = opts?.auth === undefined ? 'Bearer token' : opts.auth
  const headers: Record<string, string> = {}
  if (authValue) headers.authorization = authValue
  return new NextRequest(BASE_URL, { method: 'DELETE', headers })
}

describe('DELETE /api/routes-d/auth/2fa', () => {
  beforeEach(() => vi.clearAllMocks())

  // ── Auth ──────────────────────────────────────────────────────────────────

  it('returns 401 when no authorization header is provided', async () => {
    const { DELETE } = await import('@/app/api/routes-d/auth/2fa/route')
    const res = await DELETE(makeRequest({ auth: null }))
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe('Unauthorized')
    expect(userFindUnique).not.toHaveBeenCalled()
  })

  it('returns 401 when the auth token is invalid', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { DELETE } = await import('@/app/api/routes-d/auth/2fa/route')
    const res = await DELETE(makeRequest())
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe('Invalid token')
    expect(userUpdate).not.toHaveBeenCalled()
  })

  it('returns 404 when user is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(null)
    const { DELETE } = await import('@/app/api/routes-d/auth/2fa/route')
    const res = await DELETE(makeRequest())
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toBe('User not found')
    expect(userUpdate).not.toHaveBeenCalled()
  })

  // ── Conflict ──────────────────────────────────────────────────────────────

  it('returns 409 when 2FA is already disabled', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({
      id: 'user_1',
      twoFactorEnabled: false,
      twoFactorSecret: null,
    })
    const { DELETE } = await import('@/app/api/routes-d/auth/2fa/route')
    const res = await DELETE(makeRequest())
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.error).toBe('2FA is already disabled')
    expect(userUpdate).not.toHaveBeenCalled()
  })

  // ── Happy path ────────────────────────────────────────────────────────────

  it('disables 2FA and returns enabled:false with a disabledAt timestamp', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({
      id: 'user_1',
      twoFactorEnabled: true,
      twoFactorSecret: 'SOMESECRET',
    })
    userUpdate.mockResolvedValue({ id: 'user_1' })
    const { DELETE } = await import('@/app/api/routes-d/auth/2fa/route')
    const res = await DELETE(makeRequest())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.twoFactor.enabled).toBe(false)
    expect(json.twoFactor.disabledAt).toBeTruthy()
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: 'user_1' },
      data: { twoFactorEnabled: false, twoFactorSecret: null },
    })
  })

  it('clears the twoFactorSecret when disabling', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({
      id: 'user_1',
      twoFactorEnabled: true,
      twoFactorSecret: 'SECRETVALUE',
    })
    userUpdate.mockResolvedValue({ id: 'user_1' })
    const { DELETE } = await import('@/app/api/routes-d/auth/2fa/route')
    await DELETE(makeRequest())
    expect(userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ twoFactorSecret: null }),
      }),
    )
  })

  // ── Error handling ────────────────────────────────────────────────────────

  it('returns 500 on an unexpected database error', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockRejectedValue(new Error('DB crash'))
    const { DELETE } = await import('@/app/api/routes-d/auth/2fa/route')
    const res = await DELETE(makeRequest())
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error).toBe('Failed to disable two-factor authentication')
    expect(loggerError).toHaveBeenCalled()
  })
})
