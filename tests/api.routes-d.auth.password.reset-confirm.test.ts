import { createHash } from 'crypto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const userUpdate = vi.fn()
const resetTokenFindUnique = vi.fn()
const resetTokenUpdate = vi.fn()
const loggerError = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique, update: userUpdate },
    passwordResetToken: { findUnique: resetTokenFindUnique, update: resetTokenUpdate },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: loggerError } }))

const BASE_URL = 'http://localhost/api/routes-d/auth/password/reset-confirm'

function makePost(body: unknown, headers: Record<string, string> = { authorization: 'Bearer token' }) {
  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function importRoute() {
  return import('@/app/api/routes-d/auth/password/reset-confirm/route')
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

const validToken = {
  id: 'prt_1',
  userId: 'user_1',
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  usedAt: null,
}

describe('POST /api/routes-d/auth/password/reset-confirm (#1235)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
  })

  it('returns 401 when no auth token is provided', async () => {
    const { POST } = await importRoute()
    const response = await POST(makePost({ token: 't', newPassword: 'longenough' }, {}))

    expect(response.status).toBe(401)
    expect(resetTokenFindUnique).not.toHaveBeenCalled()
  })

  it('resets the password with a valid token and returns success', async () => {
    resetTokenFindUnique.mockResolvedValue(validToken)
    userUpdate.mockResolvedValue({ id: 'user_1' })
    resetTokenUpdate.mockResolvedValue({ id: 'prt_1' })

    const { POST } = await importRoute()
    const response = await POST(makePost({ token: 'reset-token', newPassword: 'S3cure-pass' }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ success: true })

    // Lookup must use the sha256 of the raw token, never the raw token itself
    expect(resetTokenFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: sha256('reset-token') } }),
    )

    // The stored password must be a salted scrypt hash, not the plaintext
    const updateArg = userUpdate.mock.calls[0][0]
    expect(updateArg.where).toEqual({ id: 'user_1' })
    expect(updateArg.data.passwordHash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/)
    expect(updateArg.data.passwordHash).not.toContain('S3cure-pass')

    expect(resetTokenUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'prt_1' },
        data: { usedAt: expect.any(Date) },
      }),
    )
  })

  it('returns 400 for an unknown token', async () => {
    resetTokenFindUnique.mockResolvedValue(null)

    const { POST } = await importRoute()
    const response = await POST(makePost({ token: 'bad', newPassword: 'longenough' }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Invalid or expired reset token',
    })
    expect(userUpdate).not.toHaveBeenCalled()
  })

  it("returns 400 for another user's token without leaking the reason", async () => {
    resetTokenFindUnique.mockResolvedValue({ ...validToken, userId: 'user_2' })

    const { POST } = await importRoute()
    const response = await POST(makePost({ token: 'stolen', newPassword: 'longenough' }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Invalid or expired reset token',
    })
    expect(userUpdate).not.toHaveBeenCalled()
  })

  it('returns 400 for an already-used token', async () => {
    resetTokenFindUnique.mockResolvedValue({ ...validToken, usedAt: new Date() })

    const { POST } = await importRoute()
    const response = await POST(makePost({ token: 'used', newPassword: 'longenough' }))

    expect(response.status).toBe(400)
    expect(userUpdate).not.toHaveBeenCalled()
  })

  it('returns 400 for an expired token', async () => {
    resetTokenFindUnique.mockResolvedValue({
      ...validToken,
      expiresAt: new Date(Date.now() - 1000),
    })

    const { POST } = await importRoute()
    const response = await POST(makePost({ token: 'expired', newPassword: 'longenough' }))

    expect(response.status).toBe(400)
    expect(userUpdate).not.toHaveBeenCalled()
  })

  it('returns 400 for invalid JSON', async () => {
    const { POST } = await importRoute()
    const response = await POST(makePost('not-json'))

    expect(response.status).toBe(400)
    expect(resetTokenFindUnique).not.toHaveBeenCalled()
  })

  it('returns 400 when token is missing or empty', async () => {
    const { POST } = await importRoute()

    const missing = await POST(makePost({ newPassword: 'longenough' }))
    expect(missing.status).toBe(400)

    const empty = await POST(makePost({ token: '  ', newPassword: 'longenough' }))
    expect(empty.status).toBe(400)

    expect(resetTokenFindUnique).not.toHaveBeenCalled()
  })

  it('returns 400 when newPassword is too short or too long', async () => {
    const { POST } = await importRoute()

    const short = await POST(makePost({ token: 't', newPassword: 'short' }))
    expect(short.status).toBe(400)

    const long = await POST(makePost({ token: 't', newPassword: 'x'.repeat(129) }))
    expect(long.status).toBe(400)

    expect(resetTokenFindUnique).not.toHaveBeenCalled()
  })

  it('returns 500 when the database update fails', async () => {
    resetTokenFindUnique.mockResolvedValue(validToken)
    userUpdate.mockRejectedValue(new Error('db down'))

    const { POST } = await importRoute()
    const response = await POST(makePost({ token: 'reset-token', newPassword: 'longenough' }))

    expect(response.status).toBe(500)
    expect(loggerError).toHaveBeenCalled()
  })
})
