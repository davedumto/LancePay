import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  verifyAuthToken: vi.fn(),
  userFindUnique: vi.fn(),
  paymentMethodFindUnique: vi.fn(),
  paymentMethodUpdateMany: vi.fn(),
  paymentMethodUpdate: vi.fn(),
  transaction: vi.fn(),
  loggerError: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: mocks.verifyAuthToken,
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    paymentMethod: {
      findUnique: mocks.paymentMethodFindUnique,
      updateMany: mocks.paymentMethodUpdateMany,
      update: mocks.paymentMethodUpdate,
    },
    $transaction: mocks.transaction,
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: mocks.loggerError },
}))

import { PATCH } from '@/app/api/routes-d/payout-methods/[id]/default/route'

const BASE_URL = 'http://localhost/api/routes-d/payout-methods/method_1/default'

function makeRequest(token: string | null = 'valid-token') {
  const headers = new Headers()
  if (token) {
    headers.set('authorization', `Bearer ${token}`)
  }
  return new NextRequest(BASE_URL, { method: 'PATCH', headers })
}

function makeRouteContext() {
  return { params: Promise.resolve({ id: 'method_1' }) }
}

describe('PATCH /api/routes-d/payout-methods/[id]/default', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when the token is invalid', async () => {
    mocks.verifyAuthToken.mockResolvedValue(null)
    const res = await PATCH(makeRequest(), makeRouteContext())
    expect(res.status).toBe(401)
  })

  it('returns 404 when the payout method does not exist', async () => {
    mocks.verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    mocks.userFindUnique.mockResolvedValue({ id: 'user_1' })
    mocks.paymentMethodFindUnique.mockResolvedValue(null)

    const res = await PATCH(makeRequest(), makeRouteContext())
    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: 'Payout method not found' })
  })

  it('returns 403 when the payout method belongs to another user', async () => {
    mocks.verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    mocks.userFindUnique.mockResolvedValue({ id: 'user_1' })
    mocks.paymentMethodFindUnique.mockResolvedValue({ id: 'method_1', userId: 'user_2', isDefault: false })

    const res = await PATCH(makeRequest(), makeRouteContext())
    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toEqual({ error: 'Forbidden' })
  })

  it('sets the selected payout method as default', async () => {
    mocks.verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    mocks.userFindUnique.mockResolvedValue({ id: 'user_1' })
    mocks.paymentMethodFindUnique.mockResolvedValue({
      id: 'method_1',
      userId: 'user_1',
      type: 'bank_account',
      name: 'Primary',
      value: '1234567890',
      isDefault: false,
    })
    mocks.paymentMethodUpdateMany.mockResolvedValue({ count: 1 })
    mocks.paymentMethodUpdate.mockResolvedValue({
      id: 'method_1',
      type: 'bank_account',
      name: 'Primary',
      value: '1234567890',
      isDefault: true,
    })
    mocks.transaction.mockImplementation(async ([clearDefault, updateDefault]: unknown[]) => {
      expect(clearDefault).toBeDefined()
      expect(updateDefault).toBeDefined()
      return [{ count: 1 }, { id: 'method_1', type: 'bank_account', name: 'Primary', value: '1234567890', isDefault: true }]
    })

    const res = await PATCH(makeRequest(), makeRouteContext())
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      payoutMethod: {
        id: 'method_1',
        type: 'bank_account',
        name: 'Primary',
        value: '1234567890',
        isDefault: true,
      },
    })
  })
})
