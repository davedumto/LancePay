import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const memberFindUnique = vi.fn()
const memberUpdate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    teamMember: { findUnique: memberFindUnique, update: memberUpdate },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

function deleteReq(id: string) {
  return new NextRequest(`http://localhost/api/routes-d/members/${id}`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer tok' },
  })
}

describe('DELETE /api/routes-d/members/[id]', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when unauthenticated', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { DELETE } = await import('@/app/api/routes-d/members/[id]/route')
    const res = await DELETE(
      new NextRequest('http://localhost/api/routes-d/members/m1', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'm1' }) },
    )
    expect(res.status).toBe(401)
  })

  it('returns 404 when member not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    memberFindUnique.mockResolvedValue(null)
    const { DELETE } = await import('@/app/api/routes-d/members/[id]/route')
    const res = await DELETE(deleteReq('gone'), { params: Promise.resolve({ id: 'gone' }) })
    expect(res.status).toBe(404)
  })

  it('returns 403 when caller is not the team owner', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    memberFindUnique.mockResolvedValue({ id: 'm1', ownerId: 'user_2', status: 'active' })
    const { DELETE } = await import('@/app/api/routes-d/members/[id]/route')
    const res = await DELETE(deleteReq('m1'), { params: Promise.resolve({ id: 'm1' }) })
    expect(res.status).toBe(403)
  })

  it('returns 409 when member is already removed', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    memberFindUnique.mockResolvedValue({ id: 'm1', ownerId: 'user_1', status: 'removed' })
    const { DELETE } = await import('@/app/api/routes-d/members/[id]/route')
    const res = await DELETE(deleteReq('m1'), { params: Promise.resolve({ id: 'm1' }) })
    expect(res.status).toBe(409)
  })

  it('removes the member and returns 204', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    memberFindUnique.mockResolvedValue({ id: 'm1', ownerId: 'user_1', status: 'active' })
    memberUpdate.mockResolvedValue({ id: 'm1', status: 'removed' })
    const { DELETE } = await import('@/app/api/routes-d/members/[id]/route')
    const res = await DELETE(deleteReq('m1'), { params: Promise.resolve({ id: 'm1' }) })
    expect(res.status).toBe(204)
    expect(memberUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'removed' }) }),
    )
  })
})
