import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const sessionFindUnique = vi.fn()
const sessionUpdate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    userSession: { findUnique: sessionFindUnique, update: sessionUpdate },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

const BASE_URL = 'http://localhost/api/routes-d/devices'

function makeRequest(id: string, token: string | null = 'valid-token') {
  const headers = new Headers()
  if (token) headers.set('authorization', `Bearer ${token}`)
  return new NextRequest(`${BASE_URL}/${id}`, { method: 'DELETE', headers })
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

describe('DELETE /api/routes-d/devices/[id]', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when no authorization header is provided', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { DELETE } = await import('@/app/api/routes-d/devices/[id]/route')
    const res = await DELETE(makeRequest('dev_1', null), ctx('dev_1'))
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe('Unauthorized')
  })

  it('returns 401 when the token is invalid', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { DELETE } = await import('@/app/api/routes-d/devices/[id]/route')
    const res = await DELETE(makeRequest('dev_1', 'bad-token'), ctx('dev_1'))
    expect(res.status).toBe(401)
    expect(sessionFindUnique).not.toHaveBeenCalled()
  })

  it('returns 404 when the device does not exist', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    sessionFindUnique.mockResolvedValue(null)
    const { DELETE } = await import('@/app/api/routes-d/devices/[id]/route')
    const res = await DELETE(makeRequest('dev_missing'), ctx('dev_missing'))
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toBe('Device not found')
  })

  it('returns 403 when the device belongs to another user', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    sessionFindUnique.mockResolvedValue({ id: 'dev_1', userId: 'user_2', revokedAt: null })
    const { DELETE } = await import('@/app/api/routes-d/devices/[id]/route')
    const res = await DELETE(makeRequest('dev_1'), ctx('dev_1'))
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.error).toBe('Forbidden')
    expect(sessionUpdate).not.toHaveBeenCalled()
  })

  it('returns 409 when the device is already removed', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    sessionFindUnique.mockResolvedValue({
      id: 'dev_1',
      userId: 'user_1',
      revokedAt: new Date('2026-01-01T00:00:00Z'),
    })
    const { DELETE } = await import('@/app/api/routes-d/devices/[id]/route')
    const res = await DELETE(makeRequest('dev_1'), ctx('dev_1'))
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.error).toBe('Device already removed')
    expect(sessionUpdate).not.toHaveBeenCalled()
  })

  it('returns 204 and revokes the session on success', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    sessionFindUnique.mockResolvedValue({ id: 'dev_1', userId: 'user_1', revokedAt: null })
    sessionUpdate.mockResolvedValue({ id: 'dev_1', revokedAt: new Date() })
    const { DELETE } = await import('@/app/api/routes-d/devices/[id]/route')
    const res = await DELETE(makeRequest('dev_1'), ctx('dev_1'))
    expect(res.status).toBe(204)
    expect(sessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'dev_1' },
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
    )
  })

  it('returns 500 on unexpected database error', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockRejectedValue(new Error('DB connection lost'))
    const { DELETE } = await import('@/app/api/routes-d/devices/[id]/route')
    const res = await DELETE(makeRequest('dev_1'), ctx('dev_1'))
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error).toBe('Failed to remove device')
  })
})
