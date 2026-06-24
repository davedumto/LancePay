import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const tokenFindMany = vi.fn()
const tokenCreate = vi.fn()
const loggerError = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/logger', () => ({ logger: { error: loggerError } }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    personalAccessToken: { findMany: tokenFindMany, create: tokenCreate },
  },
}))

const BASE_URL = 'http://localhost/api/routes-d/auth/tokens'

function makeGetRequest(opts?: { auth?: string | null }) {
  const authValue = opts?.auth === undefined ? 'Bearer token' : opts.auth
  const headers: Record<string, string> = {}
  if (authValue) headers.authorization = authValue
  return new NextRequest(BASE_URL, { method: 'GET', headers })
}

function makePostRequest(body?: unknown, opts?: { auth?: string | null }) {
  const authValue = opts?.auth === undefined ? 'Bearer token' : opts.auth
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (authValue) headers.authorization = authValue
  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

describe('GET /api/routes-d/auth/tokens', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when no authorization header is provided', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/auth/tokens/route')
    const res = await GET(makeGetRequest({ auth: null }))
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe('Unauthorized')
    expect(tokenFindMany).not.toHaveBeenCalled()
  })

  it('returns 401 when the token is invalid', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/auth/tokens/route')
    const res = await GET(makeGetRequest())
    expect(res.status).toBe(401)
    expect(tokenFindMany).not.toHaveBeenCalled()
  })

  it('returns tokens ordered by createdAt desc', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    tokenFindMany.mockResolvedValue([
      {
        id: 'tok_1',
        label: 'CI token',
        scopes: ['read:invoices'],
        tokenHint: 'abc123',
        expiresAt: null,
        createdAt: new Date('2026-06-20T00:00:00Z'),
      },
      {
        id: 'tok_2',
        label: 'Deploy token',
        scopes: ['write:webhooks'],
        tokenHint: 'xyz789',
        expiresAt: new Date('2027-01-01T00:00:00Z'),
        createdAt: new Date('2026-06-15T00:00:00Z'),
      },
    ])
    const { GET } = await import('@/app/api/routes-d/auth/tokens/route')
    const res = await GET(makeGetRequest())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.tokens).toHaveLength(2)
    expect(json.tokens[0].id).toBe('tok_1')
    expect(json.tokens[0].label).toBe('CI token')
    expect(json.tokens[0].tokenHint).toBe('abc123')
    expect(tokenFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user_1' },
        orderBy: { createdAt: 'desc' },
      }),
    )
  })

  it('returns an empty list when the user has no tokens', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    tokenFindMany.mockResolvedValue([])
    const { GET } = await import('@/app/api/routes-d/auth/tokens/route')
    const res = await GET(makeGetRequest())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.tokens).toEqual([])
  })

  it('returns 500 on an unexpected database error', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockRejectedValue(new Error('DB crash'))
    const { GET } = await import('@/app/api/routes-d/auth/tokens/route')
    const res = await GET(makeGetRequest())
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error).toBe('Failed to list tokens')
    expect(loggerError).toHaveBeenCalled()
  })
})

describe('POST /api/routes-d/auth/tokens', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when no authorization header is provided', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-d/auth/tokens/route')
    const res = await POST(makePostRequest({ label: 'My token' }, { auth: null }))
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe('Unauthorized')
    expect(tokenCreate).not.toHaveBeenCalled()
  })

  it('returns 401 when the token is invalid', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-d/auth/tokens/route')
    const res = await POST(makePostRequest({ label: 'My token' }))
    expect(res.status).toBe(401)
    expect(tokenCreate).not.toHaveBeenCalled()
  })

  it('returns 400 when label is missing', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { POST } = await import('@/app/api/routes-d/auth/tokens/route')
    const res = await POST(makePostRequest({ scopes: ['read:invoices'] }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe('label is required')
    expect(tokenCreate).not.toHaveBeenCalled()
  })

  it('returns 400 when label is an empty string', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { POST } = await import('@/app/api/routes-d/auth/tokens/route')
    const res = await POST(makePostRequest({ label: '   ' }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe('label is required')
  })

  it('creates a token and returns the raw token plus metadata', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    tokenCreate.mockResolvedValue({
      id: 'tok_new',
      label: 'My token',
      scopes: ['read:invoices'],
      tokenHint: 'abc123',
      expiresAt: null,
      createdAt: new Date('2026-06-24T00:00:00Z'),
    })
    const { POST } = await import('@/app/api/routes-d/auth/tokens/route')
    const res = await POST(makePostRequest({ label: 'My token', scopes: ['read:invoices'] }))
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.token).toBeTruthy()
    expect(typeof json.token).toBe('string')
    expect(json.token).toHaveLength(64) // 32 bytes hex
    expect(json.meta.id).toBe('tok_new')
    expect(json.meta.label).toBe('My token')
    expect(json.meta.scopes).toEqual(['read:invoices'])
    expect(json.meta.tokenHint).toBe('abc123')
  })

  it('stores the last 6 chars of the raw token as tokenHint', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    let capturedData: Record<string, unknown> = {}
    tokenCreate.mockImplementation((args: Record<string, unknown>) => {
      capturedData = (args.data ?? {}) as Record<string, unknown>
      return Promise.resolve({
        id: 'tok_x',
        label: capturedData.label,
        scopes: capturedData.scopes,
        tokenHint: capturedData.tokenHint,
        expiresAt: null,
        createdAt: new Date(),
      })
    })
    const { POST } = await import('@/app/api/routes-d/auth/tokens/route')
    const res = await POST(makePostRequest({ label: 'Test' }))
    expect(res.status).toBe(201)
    const json = await res.json()
    const rawToken = json.token as string
    expect(capturedData.tokenHint).toBe(rawToken.slice(-6))
  })

  it('computes expiresAt from expiresIn seconds when provided', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const before = Date.now()
    const expiresIn = 3600
    tokenCreate.mockImplementation((args: Record<string, unknown>) => {
      const data = (args.data ?? {}) as Record<string, unknown>
      return Promise.resolve({
        id: 'tok_y',
        label: data.label,
        scopes: data.scopes,
        tokenHint: data.tokenHint,
        expiresAt: data.expiresAt,
        createdAt: new Date(),
      })
    })
    const { POST } = await import('@/app/api/routes-d/auth/tokens/route')
    const res = await POST(makePostRequest({ label: 'Expiring', expiresIn }))
    expect(res.status).toBe(201)
    const json = await res.json()
    const expiresAt = new Date(json.meta.expiresAt as string).getTime()
    expect(expiresAt).toBeGreaterThanOrEqual(before + expiresIn * 1000)
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + expiresIn * 1000 + 1000)
  })

  it('returns 500 on an unexpected database error', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockRejectedValue(new Error('DB crash'))
    const { POST } = await import('@/app/api/routes-d/auth/tokens/route')
    const res = await POST(makePostRequest({ label: 'My token' }))
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error).toBe('Failed to create token')
    expect(loggerError).toHaveBeenCalled()
  })
})
