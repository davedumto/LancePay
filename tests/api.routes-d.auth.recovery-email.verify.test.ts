import { createHash } from 'crypto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const recoveryEmailFindUnique = vi.fn()
const recoveryEmailUpdate = vi.fn()
const loggerError = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    recoveryEmail: { findUnique: recoveryEmailFindUnique, update: recoveryEmailUpdate },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: loggerError } }))

const BASE_URL = 'http://localhost/api/routes-d/auth/recovery-email/verify'

function makePost(body: unknown, headers: Record<string, string> = { authorization: 'Bearer token' }) {
  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function importRoute() {
  return import('@/app/api/routes-d/auth/recovery-email/verify/route')
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

const pendingRecord = {
  id: 're_1',
  email: 'backup@example.com',
  tokenHash: sha256('verify-token'),
  tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
  verifiedAt: null,
}

describe('POST /api/routes-d/auth/recovery-email/verify (#1236)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
  })

  it('returns 401 when no auth token is provided', async () => {
    const { POST } = await importRoute()
    const response = await POST(makePost({ token: 't' }, {}))

    expect(response.status).toBe(401)
    expect(recoveryEmailFindUnique).not.toHaveBeenCalled()
  })

  it('returns 401 when the user is not found', async () => {
    userFindUnique.mockResolvedValue(null)

    const { POST } = await importRoute()
    const response = await POST(makePost({ token: 't' }))

    expect(response.status).toBe(401)
  })

  it('verifies the recovery email with a valid token', async () => {
    recoveryEmailFindUnique.mockResolvedValue(pendingRecord)
    recoveryEmailUpdate.mockResolvedValue({
      email: 'backup@example.com',
      verifiedAt: new Date('2026-07-25T00:00:00Z'),
    })

    const { POST } = await importRoute()
    const response = await POST(makePost({ token: 'verify-token' }))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.recoveryEmail).toMatchObject({ email: 'backup@example.com' })

    // Ownership: lookup is scoped to the authed user, not the token
    expect(recoveryEmailFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user_1' } }),
    )
    // The token hash must be cleared once verified
    expect(recoveryEmailUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 're_1' },
        data: expect.objectContaining({
          verifiedAt: expect.any(Date),
          tokenHash: null,
          tokenExpiresAt: null,
        }),
      }),
    )
  })

  it('returns 404 when there is no pending recovery email', async () => {
    recoveryEmailFindUnique.mockResolvedValue(null)

    const { POST } = await importRoute()
    const response = await POST(makePost({ token: 'verify-token' }))

    expect(response.status).toBe(404)
    expect(recoveryEmailUpdate).not.toHaveBeenCalled()
  })

  it('returns 400 when the recovery email is already verified', async () => {
    recoveryEmailFindUnique.mockResolvedValue({
      ...pendingRecord,
      verifiedAt: new Date(),
      tokenHash: null,
      tokenExpiresAt: null,
    })

    const { POST } = await importRoute()
    const response = await POST(makePost({ token: 'verify-token' }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Recovery email is already verified',
    })
    expect(recoveryEmailUpdate).not.toHaveBeenCalled()
  })

  it('returns 400 for a wrong token', async () => {
    recoveryEmailFindUnique.mockResolvedValue(pendingRecord)

    const { POST } = await importRoute()
    const response = await POST(makePost({ token: 'wrong-token' }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Invalid or expired verification token',
    })
    expect(recoveryEmailUpdate).not.toHaveBeenCalled()
  })

  it('returns 400 for an expired token', async () => {
    recoveryEmailFindUnique.mockResolvedValue({
      ...pendingRecord,
      tokenExpiresAt: new Date(Date.now() - 1000),
    })

    const { POST } = await importRoute()
    const response = await POST(makePost({ token: 'verify-token' }))

    expect(response.status).toBe(400)
    expect(recoveryEmailUpdate).not.toHaveBeenCalled()
  })

  it('returns 400 for invalid JSON', async () => {
    const { POST } = await importRoute()
    const response = await POST(makePost('not-json'))

    expect(response.status).toBe(400)
    expect(recoveryEmailFindUnique).not.toHaveBeenCalled()
  })

  it('returns 400 when token is missing or empty', async () => {
    const { POST } = await importRoute()

    const missing = await POST(makePost({}))
    expect(missing.status).toBe(400)

    const empty = await POST(makePost({ token: '   ' }))
    expect(empty.status).toBe(400)

    expect(recoveryEmailFindUnique).not.toHaveBeenCalled()
  })

  it('returns 500 when the database update fails', async () => {
    recoveryEmailFindUnique.mockResolvedValue(pendingRecord)
    recoveryEmailUpdate.mockRejectedValue(new Error('db down'))

    const { POST } = await importRoute()
    const response = await POST(makePost({ token: 'verify-token' }))

    expect(response.status).toBe(500)
    expect(loggerError).toHaveBeenCalled()
  })
})
