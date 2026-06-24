import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { whitelistFindUnique, whitelistDelete } = vi.hoisted(() => ({
  whitelistFindUnique: vi.fn(),
  whitelistDelete: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    whitelistAddress: {
      findUnique: whitelistFindUnique,
      delete: whitelistDelete,
    },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { DELETE } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)

const BASE_URL = 'http://localhost/api/routes-d/whitelist/addresses'

function makeDelete(addressId: string, authHeader: string | null = 'Bearer token') {
  return new NextRequest(`${BASE_URL}/${addressId}`, {
    method: 'DELETE',
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

describe('DELETE /api/routes-d/whitelist/addresses/[id]', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns 401 when unauthenticated', async () => {
    const res = await DELETE(makeDelete('addr-1', null), { params: Promise.resolve({ id: 'addr-1' }) })
    expect(res.status).toBe(401)
  })

  it('returns 401 when token is invalid', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await DELETE(makeDelete('addr-1'), { params: Promise.resolve({ id: 'addr-1' }) })
    expect(res.status).toBe(401)
  })

  it('returns 404 when user is not found', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFind.mockResolvedValue(null as never)
    const res = await DELETE(makeDelete('addr-1'), { params: Promise.resolve({ id: 'addr-1' }) })
    expect(res.status).toBe(404)
  })

  it('returns 400 when id is empty', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFind.mockResolvedValue({ id: 'user-1' } as never)
    const res = await DELETE(makeDelete(''), { params: Promise.resolve({ id: '' }) })
    expect(res.status).toBe(400)
  })

  it('returns 404 when address is not found', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFind.mockResolvedValue({ id: 'user-1' } as never)
    whitelistFindUnique.mockResolvedValue(null)

    const res = await DELETE(makeDelete('addr-1'), { params: Promise.resolve({ id: 'addr-1' }) })
    expect(res.status).toBe(404)
  })

  it('returns 403 when user does not own the address', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFind.mockResolvedValue({ id: 'user-1' } as never)
    whitelistFindUnique.mockResolvedValue({ id: 'addr-1', userId: 'other-user' })

    const res = await DELETE(makeDelete('addr-1'), { params: Promise.resolve({ id: 'addr-1' }) })
    expect(res.status).toBe(403)
  })

  it('returns 204 when address is deleted successfully', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFind.mockResolvedValue({ id: 'user-1' } as never)
    whitelistFindUnique.mockResolvedValue({ id: 'addr-1', userId: 'user-1' })
    whitelistDelete.mockResolvedValue({ id: 'addr-1' })

    const res = await DELETE(makeDelete('addr-1'), { params: Promise.resolve({ id: 'addr-1' }) })
    expect(res.status).toBe(204)
  })

  it('returns 500 on unexpected error', async () => {
    mockedVerify.mockRejectedValue(new Error('DB error') as never)
    const res = await DELETE(makeDelete('addr-1'), { params: Promise.resolve({ id: 'addr-1' }) })
    expect(res.status).toBe(500)
  })
})
