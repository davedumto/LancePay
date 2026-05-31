import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    bankAccount: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { PATCH } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedAccountFind = vi.mocked(prisma.bankAccount.findUnique)
const mockedTransaction = vi.mocked(prisma.$transaction)

const params = { params: Promise.resolve({ id: 'ba-1' }) }

function req(auth = 'Bearer token'): NextRequest {
  return new NextRequest(
    'http://localhost/api/routes-d/bank-accounts/ba-1/default',
    {
      method: 'PATCH',
      headers: auth ? { authorization: auth } : {},
    },
  )
}

const ownedNonDefault = {
  id: 'ba-1',
  userId: 'user-1',
  isDefault: false,
  bankName: 'First Bank',
  accountNumber: '3012345678',
}

beforeEach(() => {
  vi.resetAllMocks()
  mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
  mockedUserFind.mockResolvedValue({ id: 'user-1' } as never)
})

describe('PATCH /api/routes-d/bank-accounts/[id]/default', () => {
  it('returns 401 without a valid token', async () => {
    mockedVerify.mockResolvedValue(null as never)
    expect((await PATCH(req(''), params)).status).toBe(401)
  })

  it('returns 401 when the authenticated user has no account record', async () => {
    mockedUserFind.mockResolvedValue(null as never)
    expect((await PATCH(req(), params)).status).toBe(401)
  })

  it('returns 404 when the bank account does not exist', async () => {
    mockedAccountFind.mockResolvedValue(null as never)
    expect((await PATCH(req(), params)).status).toBe(404)
  })

  it('returns 403 when the bank account belongs to another user', async () => {
    mockedAccountFind.mockResolvedValue({
      ...ownedNonDefault,
      userId: 'other-user',
    } as never)
    const res = await PATCH(req(), params)
    expect(res.status).toBe(403)
    expect(mockedTransaction).not.toHaveBeenCalled()
  })

  it('is idempotent: returns 200 without a write when already default', async () => {
    mockedAccountFind.mockResolvedValue({
      ...ownedNonDefault,
      isDefault: true,
    } as never)
    const res = await PATCH(req(), params)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.isDefault).toBe(true)
    expect(mockedTransaction).not.toHaveBeenCalled()
  })

  it('promotes the account to default, clearing any previous default, atomically', async () => {
    mockedAccountFind.mockResolvedValue(ownedNonDefault as never)
    mockedTransaction.mockResolvedValue([
      { count: 1 },
      {
        id: 'ba-1',
        isDefault: true,
        bankName: 'First Bank',
        accountNumber: '3012345678',
      },
    ] as never)

    const res = await PATCH(req(), params)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({ id: 'ba-1', isDefault: true })
    // The promotion must run inside a single transaction (clear old default + set new).
    expect(mockedTransaction).toHaveBeenCalledTimes(1)
  })
})
