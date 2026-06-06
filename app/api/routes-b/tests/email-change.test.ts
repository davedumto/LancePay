import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { prismaMock, verifyAuthTokenMock } = vi.hoisted(() => {
  const prismaMock = {
    user: { findUnique: vi.fn(), update: vi.fn() },
  }
  const verifyAuthTokenMock = vi.fn()
  return { prismaMock, verifyAuthTokenMock }
})

vi.mock('@/lib/auth', () => ({ verifyAuthToken: verifyAuthTokenMock }))
vi.mock('@/lib/db', () => ({ prisma: prismaMock }))

import {
  clearTokenStore,
  consumeToken,
  issueToken,
  _expireToken,
} from '../_lib/email-change-tokens'
import { POST as changeRequest } from '../profile/email/change-request/route'
import { POST as changeConfirm } from '../profile/email/change-confirm/route'

// ── Unit tests for email-change-tokens lib ───────────────────────────

describe('email-change-tokens lib', () => {
  beforeEach(() => {
    clearTokenStore()
  })

  it('happy path: issues token and consumes it', () => {
    const token = issueToken('user-1', 'old@example.com', 'new@example.com')
    const result = consumeToken(token, 'user-1')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error()
    expect(result.newEmail).toBe('new@example.com')
  })

  it('rejects reuse of a consumed token', () => {
    const token = issueToken('user-1', 'old@example.com', 'new@example.com')
    consumeToken(token, 'user-1')
    const second = consumeToken(token, 'user-1')
    expect(second.ok).toBe(false)
    if (second.ok) throw new Error()
    expect(second.error).toBe('already_used')
  })

  it('rejects expired token', () => {
    const token = issueToken('user-1', 'old@example.com', 'new@example.com')
    _expireToken(token)
    const result = consumeToken(token, 'user-1')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error()
    expect(result.error).toBe('expired')
  })

  it('rejects unknown token', () => {
    const result = consumeToken('not-a-real-token', 'user-1')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error()
    expect(result.error).toBe('invalid_token')
  })

  it('rejects mismatched user', () => {
    const token = issueToken('user-1', 'old@example.com', 'new@example.com')
    const result = consumeToken(token, 'user-2')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error()
    expect(result.error).toBe('user_mismatch')
  })

  it('issuing a new token invalidates previous pending token for the same user', () => {
    const first = issueToken('user-1', 'old@example.com', 'first@example.com')
    issueToken('user-1', 'old@example.com', 'second@example.com')
    const result = consumeToken(first, 'user-1')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error()
    expect(result.error).toBe('invalid_token')
  })
})

// ── Route handler integration tests ──────────────────────────────────

function makeReq(path: string, body: unknown, token = 'Bearer tok') {
  return new NextRequest(`http://localhost/api/routes-b/${path}`, {
    method: 'POST',
    headers: { authorization: token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /profile/email/change-request', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearTokenStore()
    verifyAuthTokenMock.mockResolvedValue({ userId: 'privy-1' })
    prismaMock.user.findUnique.mockResolvedValue({ id: 'user-1', email: 'old@example.com' })
  })

  it('returns 401 with no token', async () => {
    const req = new NextRequest('http://localhost/api/routes-b/profile/email/change-request', {
      method: 'POST',
      body: JSON.stringify({ newEmail: 'x@example.com' }),
    })
    const res = await changeRequest(req)
    expect(res.status).toBe(401)
  })

  it('returns 400 when newEmail missing', async () => {
    const res = await changeRequest(makeReq('profile/email/change-request', {}))
    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid email format', async () => {
    const res = await changeRequest(
      makeReq('profile/email/change-request', { newEmail: 'not-an-email' }),
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 when newEmail equals current email', async () => {
    const res = await changeRequest(
      makeReq('profile/email/change-request', { newEmail: 'old@example.com' }),
    )
    expect(res.status).toBe(400)
  })

  it('happy path returns tokenIssued: true', async () => {
    const res = await changeRequest(
      makeReq('profile/email/change-request', { newEmail: 'new@example.com' }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.tokenIssued).toBe(true)
  })
})

describe('POST /profile/email/change-confirm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearTokenStore()
    verifyAuthTokenMock.mockResolvedValue({ userId: 'privy-1' })
    prismaMock.user.findUnique.mockResolvedValue({ id: 'user-1', email: 'old@example.com' })
    prismaMock.user.update.mockResolvedValue({ id: 'user-1', email: 'new@example.com' })
  })

  it('returns 400 when token missing', async () => {
    const res = await changeConfirm(makeReq('profile/email/change-confirm', {}))
    expect(res.status).toBe(400)
  })

  it('returns 400 for unknown token', async () => {
    const res = await changeConfirm(
      makeReq('profile/email/change-confirm', { token: 'garbage' }),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/invalid/i)
  })

  it('returns 400 for expired token', async () => {
    const tok = issueToken('user-1', 'old@example.com', 'new@example.com')
    _expireToken(tok)
    const res = await changeConfirm(makeReq('profile/email/change-confirm', { token: tok }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/expired/i)
  })

  it('returns 400 for reused token', async () => {
    const tok = issueToken('user-1', 'old@example.com', 'new@example.com')
    await changeConfirm(makeReq('profile/email/change-confirm', { token: tok }))
    const res = await changeConfirm(makeReq('profile/email/change-confirm', { token: tok }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/already been used/i)
  })

  it('returns 403 for mismatched user', async () => {
    const tok = issueToken('user-2', 'other@example.com', 'new@example.com')
    const res = await changeConfirm(makeReq('profile/email/change-confirm', { token: tok }))
    expect(res.status).toBe(403)
  })

  it('happy path: confirms email update', async () => {
    const tok = issueToken('user-1', 'old@example.com', 'new@example.com')
    const res = await changeConfirm(makeReq('profile/email/change-confirm', { token: tok }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.emailUpdated).toBe(true)
    expect(body.email).toBe('new@example.com')
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { email: 'new@example.com' } }),
    )
  })

  it('no DB update happens before confirm', async () => {
    issueToken('user-1', 'old@example.com', 'new@example.com')
    expect(prismaMock.user.update).not.toHaveBeenCalled()
  })
})
