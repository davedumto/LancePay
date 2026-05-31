import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    bankAccount: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { DELETE } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedAccountFind = vi.mocked(prisma.bankAccount.findUnique)
const mockedTransaction = vi.mocked(prisma.$transaction)

// Stand-in transaction client; $transaction is wired to invoke the handler's
// callback with this so we can assert the reassignment + delete behavior.
const tx = {
  bankAccount: {
    findFirst: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}

const params = { params: Promise.resolve({ id: 'ba-1' }) }

function req(auth = 'Bearer token'): NextRequest {
  return new NextRequest('http://localhost/api/routes-d/bank-accounts/ba-1', {
    method: 'DELETE',
    headers: auth ? { authorization: auth } : {},
  })
}

const ownedDefault = { id: 'ba-1', userId: 'user-1', isDefault: true }
const ownedNonDefault = { id: 'ba-1', userId: 'user-1', isDefault: false }

beforeEach(() => {
  vi.resetAllMocks()
  mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
  mockedUserFind.mockResolvedValue({ id: 'user-1' } as never)
  mockedTransaction.mockImplementation(
    async (cb: (client: typeof tx) => unknown) => cb(tx),
  )
})

describe('DELETE /api/routes-d/bank-accounts/[id]', () => {
  it('returns 401 without a valid token', async () => {
    mockedVerify.mockResolvedValue(null as never)
    expect((await DELETE(req(''), params)).status).toBe(401)
  })

  it('returns 401 when the authenticated user has no account record', async () => {
    mockedUserFind.mockResolvedValue(null as never)
    expect((await DELETE(req(), params)).status).toBe(401)
  })

  it('returns 404 when the bank account does not exist', async () => {
    mockedAccountFind.mockResolvedValue(null as never)
    const res = await DELETE(req(), params)
    expect(res.status).toBe(404)
    expect(mockedTransaction).not.toHaveBeenCalled()
  })

  it('returns 403 when the bank account belongs to another user', async () => {
    mockedAccountFind.mockResolvedValue({
      ...ownedNonDefault,
      userId: 'other-user',
    } as never)
    const res = await DELETE(req(), params)
    expect(res.status).toBe(403)
    expect(mockedTransaction).not.toHaveBeenCalled()
  })

  it('deletes a non-default account without reassigning a default', async () => {
    mockedAccountFind.mockResolvedValue(ownedNonDefault as never)
    const res = await DELETE(req(), params)
    expect(res.status).toBe(204)
    expect(tx.bankAccount.findFirst).not.toHaveBeenCalled()
    expect(tx.bankAccount.update).not.toHaveBeenCalled()
    expect(tx.bankAccount.delete).toHaveBeenCalledWith({ where: { id: 'ba-1' } })
  })

  it('promotes the oldest remaining account when deleting the default', async () => {
    mockedAccountFind.mockResolvedValue(ownedDefault as never)
    tx.bankAccount.findFirst.mockResolvedValue({ id: 'ba-2' } as never)

    const res = await DELETE(req(), params)
    expect(res.status).toBe(204)
    // Picks the oldest of the user's *other* accounts as the new default.
    expect(tx.bankAccount.findFirst).toHaveBeenCalledWith({
      where: { userId: 'user-1', id: { not: 'ba-1' } },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })
    expect(tx.bankAccount.update).toHaveBeenCalledWith({
      where: { id: 'ba-2' },
      data: { isDefault: true },
    })
    expect(tx.bankAccount.delete).toHaveBeenCalledWith({ where: { id: 'ba-1' } })
  })

  it('deletes the default account without reassigning when it is the last one', async () => {
    mockedAccountFind.mockResolvedValue(ownedDefault as never)
    tx.bankAccount.findFirst.mockResolvedValue(null as never)

    const res = await DELETE(req(), params)
    expect(res.status).toBe(204)
    expect(tx.bankAccount.update).not.toHaveBeenCalled()
    expect(tx.bankAccount.delete).toHaveBeenCalledWith({ where: { id: 'ba-1' } })
  })
})
