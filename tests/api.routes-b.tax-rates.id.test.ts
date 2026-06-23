import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const taxRateFindUnique = vi.fn()
const taxRateDelete = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    taxRate: { findUnique: taxRateFindUnique, delete: taxRateDelete },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

function deleteReq(id: string) {
  return new NextRequest(`http://localhost/api/routes-b/tax-rates/${id}`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer tok' },
  })
}

describe('DELETE /api/routes-b/tax-rates/[id]', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when unauthenticated', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { DELETE } = await import('@/app/api/routes-b/tax-rates/[id]/route')
    const res = await DELETE(
      new NextRequest('http://localhost/api/routes-b/tax-rates/tr1', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'tr1' }) },
    )
    expect(res.status).toBe(401)
  })

  it('returns 404 when tax rate not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    taxRateFindUnique.mockResolvedValue(null)
    const { DELETE } = await import('@/app/api/routes-b/tax-rates/[id]/route')
    const res = await DELETE(deleteReq('gone'), { params: Promise.resolve({ id: 'gone' }) })
    expect(res.status).toBe(404)
  })

  it('returns 403 when tax rate belongs to another user', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    taxRateFindUnique.mockResolvedValue({ id: 'tr1', userId: 'user_2' })
    const { DELETE } = await import('@/app/api/routes-b/tax-rates/[id]/route')
    const res = await DELETE(deleteReq('tr1'), { params: Promise.resolve({ id: 'tr1' }) })
    expect(res.status).toBe(403)
  })

  it('deletes the tax rate and returns 204', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    taxRateFindUnique.mockResolvedValue({ id: 'tr1', userId: 'user_1' })
    taxRateDelete.mockResolvedValue({ id: 'tr1' })
    const { DELETE } = await import('@/app/api/routes-b/tax-rates/[id]/route')
    const res = await DELETE(deleteReq('tr1'), { params: Promise.resolve({ id: 'tr1' }) })
    expect(res.status).toBe(204)
    expect(taxRateDelete).toHaveBeenCalledWith({ where: { id: 'tr1' } })
  })
})
