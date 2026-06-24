import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const exportFindUnique = vi.fn()
const loggerError = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/logger', () => ({ logger: { error: loggerError } }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    dataExport: { findUnique: exportFindUnique },
  },
}))

const BASE_URL = 'http://localhost/api/routes-d/account/export'

function makeRequest(id: string, opts?: { auth?: string | null }) {
  const authValue = opts?.auth === undefined ? 'Bearer token' : opts.auth
  const headers: Record<string, string> = {}
  if (authValue) headers.authorization = authValue
  return new NextRequest(`${BASE_URL}/${id}`, { method: 'GET', headers })
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

describe('GET /api/routes-d/account/export/[id]', () => {
  beforeEach(() => vi.clearAllMocks())

  // ── Auth ──────────────────────────────────────────────────────────────────

  it('returns 401 when no authorization header is provided', async () => {
    const { GET } = await import('@/app/api/routes-d/account/export/[id]/route')
    const res = await GET(makeRequest('exp_1', { auth: null }), makeParams('exp_1'))
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe('Unauthorized')
    expect(exportFindUnique).not.toHaveBeenCalled()
  })

  it('returns 401 when the auth token is invalid', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/account/export/[id]/route')
    const res = await GET(makeRequest('exp_1'), makeParams('exp_1'))
    expect(res.status).toBe(401)
    expect(exportFindUnique).not.toHaveBeenCalled()
  })

  it('returns 404 when user is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/account/export/[id]/route')
    const res = await GET(makeRequest('exp_1'), makeParams('exp_1'))
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toBe('User not found')
  })

  // ── Not found ─────────────────────────────────────────────────────────────

  it('returns 404 when the export does not exist', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    exportFindUnique.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/account/export/[id]/route')
    const res = await GET(makeRequest('exp_missing'), makeParams('exp_missing'))
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toBe('Export not found')
  })

  // ── Authorization ─────────────────────────────────────────────────────────

  it('returns 403 when the export belongs to another user', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    exportFindUnique.mockResolvedValue({
      id: 'exp_1',
      userId: 'user_other',
      status: 'completed',
      format: 'json',
      fileUrl: 'https://example.com/export.json',
      createdAt: new Date('2026-06-20T00:00:00Z'),
      completedAt: new Date('2026-06-20T01:00:00Z'),
    })
    const { GET } = await import('@/app/api/routes-d/account/export/[id]/route')
    const res = await GET(makeRequest('exp_1'), makeParams('exp_1'))
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.error).toBe('Forbidden')
  })

  // ── Status-based responses ────────────────────────────────────────────────

  it('returns 202 when the export is pending', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    exportFindUnique.mockResolvedValue({
      id: 'exp_1',
      userId: 'user_1',
      status: 'pending',
      format: 'json',
      fileUrl: null,
      createdAt: new Date('2026-06-24T00:00:00Z'),
      completedAt: null,
    })
    const { GET } = await import('@/app/api/routes-d/account/export/[id]/route')
    const res = await GET(makeRequest('exp_1'), makeParams('exp_1'))
    expect(res.status).toBe(202)
    const json = await res.json()
    expect(json.status).toBe('pending')
    expect(json.message).toBe('Export not ready')
  })

  it('returns 202 when the export is processing', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    exportFindUnique.mockResolvedValue({
      id: 'exp_1',
      userId: 'user_1',
      status: 'processing',
      format: 'csv',
      fileUrl: null,
      createdAt: new Date('2026-06-24T00:00:00Z'),
      completedAt: null,
    })
    const { GET } = await import('@/app/api/routes-d/account/export/[id]/route')
    const res = await GET(makeRequest('exp_1'), makeParams('exp_1'))
    expect(res.status).toBe(202)
    const json = await res.json()
    expect(json.status).toBe('processing')
    expect(json.message).toBe('Export not ready')
  })

  it('returns 422 when the export has failed', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    exportFindUnique.mockResolvedValue({
      id: 'exp_1',
      userId: 'user_1',
      status: 'failed',
      format: 'json',
      fileUrl: null,
      createdAt: new Date('2026-06-24T00:00:00Z'),
      completedAt: null,
    })
    const { GET } = await import('@/app/api/routes-d/account/export/[id]/route')
    const res = await GET(makeRequest('exp_1'), makeParams('exp_1'))
    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.status).toBe('failed')
    expect(json.error).toBe('Export generation failed')
  })

  // ── Happy path ────────────────────────────────────────────────────────────

  it('returns 200 with export metadata and downloadUrl when completed', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    exportFindUnique.mockResolvedValue({
      id: 'exp_1',
      userId: 'user_1',
      status: 'completed',
      format: 'json',
      fileUrl: 'https://cdn.example.com/exports/exp_1.json',
      createdAt: new Date('2026-06-24T00:00:00Z'),
      completedAt: new Date('2026-06-24T01:00:00Z'),
    })
    const { GET } = await import('@/app/api/routes-d/account/export/[id]/route')
    const res = await GET(makeRequest('exp_1'), makeParams('exp_1'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.id).toBe('exp_1')
    expect(json.status).toBe('completed')
    expect(json.format).toBe('json')
    expect(json.downloadUrl).toBe('https://cdn.example.com/exports/exp_1.json')
    expect(json.requestedAt).toBeTruthy()
    expect(json.completedAt).toBeTruthy()
  })

  it('returns null for downloadUrl when fileUrl is not set', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    exportFindUnique.mockResolvedValue({
      id: 'exp_1',
      userId: 'user_1',
      status: 'completed',
      format: 'csv',
      fileUrl: null,
      createdAt: new Date('2026-06-24T00:00:00Z'),
      completedAt: new Date('2026-06-24T01:00:00Z'),
    })
    const { GET } = await import('@/app/api/routes-d/account/export/[id]/route')
    const res = await GET(makeRequest('exp_1'), makeParams('exp_1'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.downloadUrl).toBeNull()
  })

  it('looks up the export by the id from route params', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    exportFindUnique.mockResolvedValue({
      id: 'exp_abc',
      userId: 'user_1',
      status: 'completed',
      format: 'json',
      fileUrl: null,
      createdAt: new Date(),
      completedAt: new Date(),
    })
    const { GET } = await import('@/app/api/routes-d/account/export/[id]/route')
    await GET(makeRequest('exp_abc'), makeParams('exp_abc'))
    expect(exportFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'exp_abc' } }),
    )
  })

  // ── Error handling ────────────────────────────────────────────────────────

  it('returns 500 on an unexpected database error', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockRejectedValue(new Error('DB crash'))
    const { GET } = await import('@/app/api/routes-d/account/export/[id]/route')
    const res = await GET(makeRequest('exp_1'), makeParams('exp_1'))
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error).toBe('Failed to retrieve export')
    expect(loggerError).toHaveBeenCalled()
  })
})
