import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { PATCH } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const userDelegate = prisma.user as unknown as {
  findUnique: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
}

const MEMBER_ID = 'member-uuid-1'
const BASE_URL = `http://localhost/api/routes-d/members/${MEMBER_ID}/role`

function makePatch(body: unknown, authHeader: string | null = 'Bearer token') {
  return new NextRequest(BASE_URL, {
    method: 'PATCH',
    headers: authHeader ? { authorization: authHeader, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const PARAMS = { params: { id: MEMBER_ID } }

describe('PATCH /api/routes-d/members/[id]/role', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns 401 when unauthenticated', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await PATCH(makePatch({ role: 'admin' }, null), PARAMS)
    expect(res.status).toBe(401)
  })

  it('returns 403 when caller is not an admin', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValueOnce({ id: 'actor-1', role: 'freelancer' })
    const res = await PATCH(makePatch({ role: 'admin' }), PARAMS)
    expect(res.status).toBe(403)
  })

  it('returns 400 when role is missing', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValueOnce({ id: 'actor-1', role: 'admin' })
    const res = await PATCH(makePatch({}), PARAMS)
    expect(res.status).toBe(400)
  })

  it('returns 400 when role is invalid', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValueOnce({ id: 'actor-1', role: 'admin' })
    const res = await PATCH(makePatch({ role: 'superuser' }), PARAMS)
    expect(res.status).toBe(400)
  })

  it('returns 404 when member does not exist', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique
      .mockResolvedValueOnce({ id: 'actor-1', role: 'admin' })
      .mockResolvedValueOnce(null)
    const res = await PATCH(makePatch({ role: 'client' }), PARAMS)
    expect(res.status).toBe(404)
  })

  it('returns 422 when admin tries to change their own role', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique
      .mockResolvedValueOnce({ id: 'actor-1', role: 'admin' })
      .mockResolvedValueOnce({ id: 'actor-1', role: 'admin', email: 'a@example.com' })
    const res = await PATCH(makePatch({ role: 'freelancer' }), { params: { id: 'actor-1' } })
    expect(res.status).toBe(422)
  })

  it('updates the member role and returns 200', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique
      .mockResolvedValueOnce({ id: 'actor-1', role: 'admin' })
      .mockResolvedValueOnce({ id: MEMBER_ID, role: 'freelancer', email: 'm@example.com' })
    userDelegate.update.mockResolvedValue({
      id: MEMBER_ID,
      email: 'm@example.com',
      role: 'client',
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    })
    const res = await PATCH(makePatch({ role: 'client' }), PARAMS)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.member).toMatchObject({ id: MEMBER_ID, role: 'client' })
    expect(userDelegate.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: MEMBER_ID }, data: { role: 'client' } }),
    )
  })
})
