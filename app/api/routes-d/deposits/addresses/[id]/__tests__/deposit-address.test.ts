import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    depositAddress: { findUnique: vi.fn(), delete: vi.fn() },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { DELETE } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const userDelegate = prisma.user as unknown as { findUnique: ReturnType<typeof vi.fn> }
const addressDelegate = (prisma as unknown as {
  depositAddress: { findUnique: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> }
}).depositAddress

const ADDRESS_ID = 'deposit-address-uuid-1'
const BASE_URL = `http://localhost/api/routes-d/deposits/addresses/${ADDRESS_ID}`

function makeDelete(authHeader: string | null = 'Bearer token') {
  return new NextRequest(BASE_URL, {
    method: 'DELETE',
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

const PARAMS = { params: Promise.resolve({ id: ADDRESS_ID }) }

describe('DELETE /api/routes-d/deposits/addresses/[id]', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns 401 when the authorization header is missing', async () => {
    const res = await DELETE(makeDelete(null), PARAMS)
    expect(res.status).toBe(401)
    expect(addressDelegate.delete).not.toHaveBeenCalled()
  })

  it('returns 401 when the token is invalid', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await DELETE(makeDelete(), PARAMS)
    expect(res.status).toBe(401)
  })

  it('returns 404 when the user does not exist', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValueOnce(null)
    const res = await DELETE(makeDelete(), PARAMS)
    expect(res.status).toBe(404)
  })

  it('returns 400 when the id param is empty', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValueOnce({ id: 'user-1' })
    const res = await DELETE(makeDelete(), { params: Promise.resolve({ id: '' }) })
    expect(res.status).toBe(400)
  })

  it('returns 404 when the deposit address does not exist', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValueOnce({ id: 'user-1' })
    addressDelegate.findUnique.mockResolvedValueOnce(null)
    const res = await DELETE(makeDelete(), PARAMS)
    expect(res.status).toBe(404)
  })

  it('returns 403 when the caller does not own the address', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValueOnce({ id: 'user-1' })
    addressDelegate.findUnique.mockResolvedValueOnce({ id: ADDRESS_ID, userId: 'user-2' })
    const res = await DELETE(makeDelete(), PARAMS)
    expect(res.status).toBe(403)
    expect(addressDelegate.delete).not.toHaveBeenCalled()
  })

  it('deletes the address and returns 204', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValueOnce({ id: 'user-1' })
    addressDelegate.findUnique.mockResolvedValueOnce({ id: ADDRESS_ID, userId: 'user-1' })
    addressDelegate.delete.mockResolvedValueOnce({ id: ADDRESS_ID })
    const res = await DELETE(makeDelete(), PARAMS)
    expect(res.status).toBe(204)
    expect(addressDelegate.delete).toHaveBeenCalledWith({ where: { id: ADDRESS_ID } })
  })

  it('returns 500 when the delete fails unexpectedly', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValueOnce({ id: 'user-1' })
    addressDelegate.findUnique.mockResolvedValueOnce({ id: ADDRESS_ID, userId: 'user-1' })
    addressDelegate.delete.mockRejectedValueOnce(new Error('db down'))
    const res = await DELETE(makeDelete(), PARAMS)
    expect(res.status).toBe(500)
  })
})
