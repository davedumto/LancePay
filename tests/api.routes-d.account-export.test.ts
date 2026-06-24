import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const exportFindFirst = vi.fn()
const exportCreate = vi.fn()
const loggerError = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/logger', () => ({ logger: { error: loggerError } }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    dataExport: { findFirst: exportFindFirst, create: exportCreate },
  },
}))

const BASE_URL = 'http://localhost/api/routes-d/account/export'

function makeRequest(body?: unknown, opts?: { auth?: string | null }) {
  const authValue = opts?.auth === undefined ? 'Bearer token' : opts.auth
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (authValue) headers.authorization = authValue
  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

describe('POST /api/routes-d/account/export', () => {
  beforeEach(() => vi.clearAllMocks())

  // ── Auth ──────────────────────────────────────────────────────────────────

  it('returns 401 when no authorization header is provided', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-d/account/export/route')
    const res = await POST(makeRequest({}, { auth: null }))
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe('Unauthorized')
    expect(exportCreate).not.toHaveBeenCalled()
  })

  it('returns 401 when the token is invalid', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-d/account/export/route')
    const res = await POST(makeRequest({}))
    expect(res.status).toBe(401)
    expect(exportCreate).not.toHaveBeenCalled()
  })

  // ── Validation ────────────────────────────────────────────────────────────

  it('returns 400 for an invalid format value', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { POST } = await import('@/app/api/routes-d/account/export/route')
    const res = await POST(makeRequest({ format: 'xlsx' }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/format must be one of/)
    expect(exportCreate).not.toHaveBeenCalled()
  })

  it('returns 400 when includeData is not an array', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { POST } = await import('@/app/api/routes-d/account/export/route')
    const res = await POST(makeRequest({ includeData: 'invoices' }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/non-empty array/)
    expect(exportCreate).not.toHaveBeenCalled()
  })

  it('returns 400 when includeData is an empty array', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { POST } = await import('@/app/api/routes-d/account/export/route')
    const res = await POST(makeRequest({ includeData: [] }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/non-empty array/)
  })

  it('returns 400 when includeData contains an invalid scope', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { POST } = await import('@/app/api/routes-d/account/export/route')
    const res = await POST(makeRequest({ includeData: ['invoices', 'unknown_scope'] }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/Invalid data scope/)
    expect(json.error).toMatch(/unknown_scope/)
  })

  // ── Idempotency ───────────────────────────────────────────────────────────

  it('returns 409 when a pending export already exists', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    exportFindFirst.mockResolvedValue({
      id: 'exp_existing',
      format: 'json',
      createdAt: new Date('2026-06-20T00:00:00Z'),
    })
    const { POST } = await import('@/app/api/routes-d/account/export/route')
    const res = await POST(makeRequest({}))
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.id).toBe('exp_existing')
    expect(json.status).toBe('pending')
    expect(json.message).toMatch(/already pending/)
    expect(exportCreate).not.toHaveBeenCalled()
  })

  // ── Happy path ────────────────────────────────────────────────────────────

  it('creates an export with default format (json) and all scopes when body is empty', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    exportFindFirst.mockResolvedValue(null)
    exportCreate.mockResolvedValue({
      id: 'exp_1',
      status: 'pending',
      format: 'json',
      includeData: ['invoices', 'transactions', 'contacts', 'settings', 'bank_accounts'],
      createdAt: new Date('2026-06-24T00:00:00Z'),
    })
    const { POST } = await import('@/app/api/routes-d/account/export/route')
    const res = await POST(makeRequest({}))
    expect(res.status).toBe(202)
    const json = await res.json()
    expect(json.id).toBe('exp_1')
    expect(json.status).toBe('pending')
    expect(json.format).toBe('json')
    expect(json.message).toMatch(/queued/)
    expect(exportCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user_1',
          status: 'pending',
          format: 'json',
        }),
      }),
    )
  })

  it('creates an export with csv format when specified', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    exportFindFirst.mockResolvedValue(null)
    exportCreate.mockResolvedValue({
      id: 'exp_2',
      status: 'pending',
      format: 'csv',
      includeData: ['invoices'],
      createdAt: new Date('2026-06-24T00:00:00Z'),
    })
    const { POST } = await import('@/app/api/routes-d/account/export/route')
    const res = await POST(makeRequest({ format: 'csv', includeData: ['invoices'] }))
    expect(res.status).toBe(202)
    const json = await res.json()
    expect(json.format).toBe('csv')
    expect(exportCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          format: 'csv',
          includeData: ['invoices'],
        }),
      }),
    )
  })

  it('creates an export when body is absent (no JSON at all)', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    exportFindFirst.mockResolvedValue(null)
    exportCreate.mockResolvedValue({
      id: 'exp_3',
      status: 'pending',
      format: 'json',
      includeData: ['invoices', 'transactions', 'contacts', 'settings', 'bank_accounts'],
      createdAt: new Date('2026-06-24T00:00:00Z'),
    })
    // Send request with no body at all
    const { POST } = await import('@/app/api/routes-d/account/export/route')
    const res = await POST(
      new NextRequest(BASE_URL, {
        method: 'POST',
        headers: { authorization: 'Bearer token' },
      }),
    )
    expect(res.status).toBe(202)
  })

  it('checks for pending export scoped to the authenticated user', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    exportFindFirst.mockResolvedValue(null)
    exportCreate.mockResolvedValue({
      id: 'exp_4',
      status: 'pending',
      format: 'json',
      includeData: [],
      createdAt: new Date(),
    })
    const { POST } = await import('@/app/api/routes-d/account/export/route')
    await POST(makeRequest({}))
    expect(exportFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user_1', status: 'pending' },
      }),
    )
  })

  // ── Error handling ────────────────────────────────────────────────────────

  it('returns 500 on an unexpected database error', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockRejectedValue(new Error('DB crash'))
    const { POST } = await import('@/app/api/routes-d/account/export/route')
    const res = await POST(makeRequest({}))
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error).toBe('Failed to request data export')
    expect(loggerError).toHaveBeenCalled()
  })
})
