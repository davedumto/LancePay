import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const userFindFirst = vi.fn()
const invoiceFindMany = vi.fn()
const loggerError = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/logger', () => ({ logger: { error: loggerError } }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique, findFirst: userFindFirst },
    invoice: { findMany: invoiceFindMany },
  },
}))

const BASE_URL = 'http://localhost/api/routes-b/clients/test-id/invite'

function makeRequest(method: string, body?: unknown) {
  return new NextRequest(BASE_URL, {
    method,
    headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

function makeParams(id: string = 'test-id') {
  return Promise.resolve({ id })
}

describe('POST /api/routes-b/clients/[id]/invite', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 for unauthenticated requests', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-b/clients/[id]/invite/route')
    const res = await POST(makeRequest('POST', { email: 'test@example.com' }), { params: makeParams() })
    expect(res.status).toBe(401)
  })

  it('returns 404 when user is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-b/clients/[id]/invite/route')
    const res = await POST(makeRequest('POST', { email: 'test@example.com' }), { params: makeParams() })
    expect(res.status).toBe(404)
  })

  it('returns 400 when email is missing', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { POST } = await import('@/app/api/routes-b/clients/[id]/invite/route')
    const res = await POST(makeRequest('POST', {}), { params: makeParams() })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/email/)
  })

  it('returns 400 when email is not a string', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { POST } = await import('@/app/api/routes-b/clients/[id]/invite/route')
    const res = await POST(makeRequest('POST', { email: 123 }), { params: makeParams() })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/email/)
  })

  it('returns 400 for invalid email format', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { POST } = await import('@/app/api/routes-b/clients/[id]/invite/route')
    const res = await POST(makeRequest('POST', { email: 'invalid-email' }), { params: makeParams() })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/Invalid email format/)
  })

  it('returns 404 when client is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    userFindFirst.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-b/clients/[id]/invite/route')
    const res = await POST(makeRequest('POST', { email: 'test@example.com' }), { params: makeParams() })
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toMatch(/Client not found/)
  })

  it('returns 403 when user has no ownership over client', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    userFindFirst.mockResolvedValue({ id: 'test-id', role: 'client' })
    invoiceFindMany.mockResolvedValue([])
    const { POST } = await import('@/app/api/routes-b/clients/[id]/invite/route')
    const res = await POST(makeRequest('POST', { email: 'test@example.com' }), { params: makeParams() })
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.error).toMatch(/No ownership/)
  })

  it('creates invite successfully and returns 200', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    userFindFirst.mockResolvedValue({ id: 'test-id', role: 'client' })
    invoiceFindMany.mockResolvedValue([{ id: 'inv_1' }])
    const { POST } = await import('@/app/api/routes-b/clients/[id]/invite/route')
    const res = await POST(makeRequest('POST', { email: 'test@example.com' }), { params: makeParams() })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.message).toBe('Client invite created successfully')
    expect(json.clientId).toBe('test-id')
    expect(json).toHaveProperty('inviteToken')
    expect(json).toHaveProperty('inviteUrl')
    expect(json).toHaveProperty('expiresAt')
  })

  it('generates a 64-character hex invite token', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    userFindFirst.mockResolvedValue({ id: 'test-id', role: 'client' })
    invoiceFindMany.mockResolvedValue([{ id: 'inv_1' }])
    const { POST } = await import('@/app/api/routes-b/clients/[id]/invite/route')
    const res = await POST(makeRequest('POST', { email: 'test@example.com' }), { params: makeParams() })
    const json = await res.json()
    expect(json.inviteToken).toMatch(/^[0-9a-f]{64}$/)
  })

  it('sets invite expiry to 7 days from now', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    userFindFirst.mockResolvedValue({ id: 'test-id', role: 'client' })
    invoiceFindMany.mockResolvedValue([{ id: 'inv_1' }])
    const { POST } = await import('@/app/api/routes-b/clients/[id]/invite/route')
    const res = await POST(makeRequest('POST', { email: 'test@example.com' }), { params: makeParams() })
    const json = await res.json()
    const now = new Date()
    const expiry = new Date(json.expiresAt)
    const diffDays = (expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
    expect(diffDays).toBeCloseTo(7, 0)
  })

  it('includes invite URL with token', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    userFindFirst.mockResolvedValue({ id: 'test-id', role: 'client' })
    invoiceFindMany.mockResolvedValue([{ id: 'inv_1' }])
    const { POST } = await import('@/app/api/routes-b/clients/[id]/invite/route')
    const res = await POST(makeRequest('POST', { email: 'test@example.com' }), { params: makeParams() })
    const json = await res.json()
    expect(json.inviteUrl).toContain(json.inviteToken)
    expect(json.inviteUrl).toContain('/portal/invite/')
  })
})
