import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const findUnique = vi.fn()
const apiFindFirst = vi.fn()
const apiUpdate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique },
    apiKey: { findFirst: apiFindFirst, update: apiUpdate },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

const URL = 'http://localhost/api/routes-d/api-keys/key-1'

function req() {
  return new NextRequest(URL, { method: 'DELETE', headers: { authorization: 'Bearer tok' } })
}

describe('DELETE /api/routes-d/api-keys/[id]', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 with no token', async () => {
    const { DELETE } = await import('@/app/api/routes-d/api-keys/[id]/route')
    const res = await DELETE(new NextRequest(URL, { method: 'DELETE' }), { params: Promise.resolve({ id: 'key-1' }) })
    expect(res.status).toBe(401)
  })

  it('returns 404 when key not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    apiFindFirst.mockResolvedValue(null)
    const { DELETE } = await import('@/app/api/routes-d/api-keys/[id]/route')
    const res = await DELETE(req(), { params: Promise.resolve({ id: 'key-1' }) })
    expect(res.status).toBe(404)
  })

  it('returns 409 when key already revoked', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    apiFindFirst.mockResolvedValue({ id: 'key-1', revoked: true })
    const { DELETE } = await import('@/app/api/routes-d/api-keys/[id]/route')
    const res = await DELETE(req(), { params: Promise.resolve({ id: 'key-1' }) })
    expect(res.status).toBe(409)
  })

  it('revokes the key and returns 204', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    apiFindFirst.mockResolvedValue({ id: 'key-1', revoked: false })
    apiUpdate.mockResolvedValue({})
    const { DELETE } = await import('@/app/api/routes-d/api-keys/[id]/route')
    const res = await DELETE(req(), { params: Promise.resolve({ id: 'key-1' }) })
    expect(res.status).toBe(204)
  })
})
