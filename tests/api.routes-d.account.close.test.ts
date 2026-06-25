import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const userUpdate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique, update: userUpdate },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

const URL = 'http://localhost/api/routes-d/account/close'

function postReq(body?: object) {
  return new NextRequest(URL, {
    method: 'POST',
    headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

describe('POST /api/routes-d/account/close', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when no auth token', async () => {
    const { POST } = await import('@/app/api/routes-d/account/close/route')
    const res = await POST(new NextRequest(URL, { method: 'POST' }))
    expect(res.status).toBe(401)
  })

  it('returns 401 when token is invalid', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-d/account/close/route')
    const res = await POST(postReq())
    expect(res.status).toBe(401)
  })

  it('returns 401 when user not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-d/account/close/route')
    const res = await POST(postReq())
    expect(res.status).toBe(401)
  })

  it('returns 409 when account is already closed', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1', status: 'closed' })
    const { POST } = await import('@/app/api/routes-d/account/close/route')
    const res = await POST(postReq({ reason: 'no longer needed' }))
    expect(res.status).toBe(409)
  })

  it('closes account successfully with a reason', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1', status: 'active' })
    userUpdate.mockResolvedValue({ id: 'user_1', status: 'closed' })
    const { POST } = await import('@/app/api/routes-d/account/close/route')
    const res = await POST(postReq({ reason: 'switching to another service' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.message).toContain('closed')
    expect(body.reason).toBe('switching to another service')
    expect(body.closedAt).toBeDefined()
  })

  it('closes account successfully without a reason', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1', status: 'active' })
    userUpdate.mockResolvedValue({ id: 'user_1', status: 'closed' })
    const { POST } = await import('@/app/api/routes-d/account/close/route')
    const res = await POST(postReq({}))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.reason).toBeNull()
  })

  it('returns 422 when reason is too long', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1', status: 'active' })
    const { POST } = await import('@/app/api/routes-d/account/close/route')
    const res = await POST(postReq({ reason: 'x'.repeat(501) }))
    expect(res.status).toBe(422)
  })
})
