import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { DELETE } from './route'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    discount: { findUnique: vi.fn(), delete: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockVerify = verifyAuthToken as unknown as ReturnType<typeof vi.fn>
const mockUserFindUnique = prisma.user.findUnique as unknown as ReturnType<typeof vi.fn>
const mockDiscountFindUnique = prisma.discount.findUnique as unknown as ReturnType<typeof vi.fn>
const mockDiscountDelete = prisma.discount.delete as unknown as ReturnType<typeof vi.fn>

function makeDelete(id: string, token: string | null = 'Bearer valid-token') {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = token
  return new NextRequest(`http://localhost/api/routes-b/discounts/${id}`, {
    method: 'DELETE',
    headers,
  })
}

function callDelete(id: string, token: string | null = 'Bearer valid-token') {
  return DELETE(makeDelete(id, token), { params: Promise.resolve({ id }) })
}

const mockDiscount = { id: 'disc-1', userId: 'user-1' }

beforeEach(() => {
  vi.clearAllMocks()
  mockVerify.mockResolvedValue({ userId: 'privy-1' })
  mockUserFindUnique.mockResolvedValue({ id: 'user-1' })
  mockDiscountFindUnique.mockResolvedValue(mockDiscount)
  mockDiscountDelete.mockResolvedValue(mockDiscount)
})

describe('DELETE /api/routes-b/discounts/[id]', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await callDelete('disc-1', null)
    expect(res.status).toBe(401)
  })

  it('returns 401 when the token is invalid', async () => {
    mockVerify.mockResolvedValue(null)
    const res = await callDelete('disc-1')
    expect(res.status).toBe(401)
  })

  it('returns 404 when the user record is missing', async () => {
    mockUserFindUnique.mockResolvedValue(null)
    const res = await callDelete('disc-1')
    expect(res.status).toBe(404)
  })

  it('returns 404 when the discount does not exist', async () => {
    mockDiscountFindUnique.mockResolvedValue(null)
    const res = await callDelete('missing')
    expect(res.status).toBe(404)
    expect(mockDiscountDelete).not.toHaveBeenCalled()
  })

  it('returns 403 when the discount belongs to another user', async () => {
    mockDiscountFindUnique.mockResolvedValue({ ...mockDiscount, userId: 'someone-else' })
    const res = await callDelete('disc-1')
    expect(res.status).toBe(403)
    expect(mockDiscountDelete).not.toHaveBeenCalled()
  })

  it('deletes the discount and returns 200 on the happy path', async () => {
    const res = await callDelete('disc-1')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.id).toBe('disc-1')
    expect(mockDiscountDelete).toHaveBeenCalledWith({ where: { id: 'disc-1' } })
  })

  it('returns 500 when an unexpected error occurs', async () => {
    mockDiscountDelete.mockRejectedValue(new Error('db unavailable'))
    const res = await callDelete('disc-1')
    expect(res.status).toBe(500)
  })
})
