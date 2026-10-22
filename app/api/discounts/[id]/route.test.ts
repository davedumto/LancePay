import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET, DELETE } from './route'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    discount: { findUnique: vi.fn(), update: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

function makeRequest(method: string, id: string, token: string | null = 'Bearer valid-token') {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = token
  return new NextRequest(`http://localhost/api/discounts/${id}`, { method, headers })
}

function callGet(id: string, token?: string | null) {
  return GET(makeRequest('GET', id, token), { params: Promise.resolve({ id }) })
}

function callDelete(id: string, token?: string | null) {
  return DELETE(makeRequest('DELETE', id, token), { params: Promise.resolve({ id }) })
}

const mockActiveDiscount = {
  id: 'disc-1',
  userId: 'user-1',
  code: 'SAVE10',
  type: 'percent',
  value: '10.00',
  active: true,
  maxRedemptions: null,
  redemptions: 0,
  expiresAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}

const mockInactiveDiscount = { ...mockActiveDiscount, active: false }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as never)
  vi.mocked(prisma.discount.findUnique).mockResolvedValue(mockActiveDiscount as never)
  vi.mocked(prisma.discount.update).mockResolvedValue(mockInactiveDiscount as never)
})

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------
describe('GET /api/discounts/[id]', () => {
  it('returns the discount on the happy path', async () => {
    const res = await callGet('disc-1')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.discount.id).toBe('disc-1')
  })

  it('returns 401 when no token is provided', async () => {
    const res = await callGet('disc-1', null)
    expect(res.status).toBe(401)
  })

  it('returns 401 when the token is invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await callGet('disc-1')
    expect(res.status).toBe(401)
  })

  it('returns 404 when the discount does not exist', async () => {
    vi.mocked(prisma.discount.findUnique).mockResolvedValue(null)
    const res = await callGet('missing')
    expect(res.status).toBe(404)
  })

  it('returns 403 when the discount belongs to another user', async () => {
    vi.mocked(prisma.discount.findUnique).mockResolvedValue({
      ...mockActiveDiscount,
      userId: 'someone-else',
    } as never)
    const res = await callGet('disc-1')
    expect(res.status).toBe(403)
  })

  it('returns 500 on unexpected error', async () => {
    vi.mocked(prisma.discount.findUnique).mockRejectedValue(new Error('db error') as never)
    const res = await callGet('disc-1')
    expect(res.status).toBe(500)
  })
})

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------
describe('DELETE /api/discounts/[id]', () => {
  it('deactivates the discount and returns 200', async () => {
    const res = await callDelete('disc-1')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.discount.active).toBe(false)
    expect(prisma.discount.update).toHaveBeenCalledWith({
      where: { id: 'disc-1' },
      data: { active: false },
    })
  })

  it('does not hard-delete the row', async () => {
    await callDelete('disc-1')
    expect(prisma.discount).not.toHaveProperty('delete')
  })

  it('returns 409 when the discount is already inactive', async () => {
    vi.mocked(prisma.discount.findUnique).mockResolvedValue(mockInactiveDiscount as never)
    const res = await callDelete('disc-1')
    expect(res.status).toBe(409)
    expect(prisma.discount.update).not.toHaveBeenCalled()
    const data = await res.json()
    expect(data.discount.active).toBe(false)
  })

  it('returns 401 when no token is provided', async () => {
    const res = await callDelete('disc-1', null)
    expect(res.status).toBe(401)
  })

  it('returns 401 when the token is invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await callDelete('disc-1')
    expect(res.status).toBe(401)
  })

  it('returns 404 when the discount does not exist', async () => {
    vi.mocked(prisma.discount.findUnique).mockResolvedValue(null)
    const res = await callDelete('missing')
    expect(res.status).toBe(404)
    expect(prisma.discount.update).not.toHaveBeenCalled()
  })

  it('returns 403 when the discount belongs to another user', async () => {
    vi.mocked(prisma.discount.findUnique).mockResolvedValue({
      ...mockActiveDiscount,
      userId: 'someone-else',
    } as never)
    const res = await callDelete('disc-1')
    expect(res.status).toBe(403)
    expect(prisma.discount.update).not.toHaveBeenCalled()
  })

  it('returns 500 on unexpected error', async () => {
    vi.mocked(prisma.discount.update).mockRejectedValue(new Error('db error') as never)
    const res = await callDelete('disc-1')
    expect(res.status).toBe(500)
  })
})
