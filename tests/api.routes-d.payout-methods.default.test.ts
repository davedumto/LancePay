import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const payoutMethodFindFirst = vi.fn()
const payoutMethodUpdateMany = vi.fn()
const payoutMethodUpdate = vi.fn()
const payoutMethodFindUnique = vi.fn()
const prismaTransaction = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    payoutMethod: {
      findFirst: payoutMethodFindFirst,
      updateMany: payoutMethodUpdateMany,
      update: payoutMethodUpdate,
      findUnique: payoutMethodFindUnique,
    },
    $transaction: prismaTransaction,
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

const URL = 'http://localhost/api/routes-d/payout-methods/pm_1/default'
const PARAMS = { params: { id: 'pm_1' } }

function patchReq() {
  return new NextRequest(URL, { method: 'PATCH', headers: { authorization: 'Bearer tok' } })
}

describe('PATCH /api/routes-d/payout-methods/[id]/default', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when no auth token', async () => {
    const { PATCH } = await import('@/app/api/routes-d/payout-methods/[id]/default/route')
    const res = await PATCH(new NextRequest(URL, { method: 'PATCH' }), PARAMS)
    expect(res.status).toBe(401)
  })

  it('returns 401 when user not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(null)
    const { PATCH } = await import('@/app/api/routes-d/payout-methods/[id]/default/route')
    const res = await PATCH(patchReq(), PARAMS)
    expect(res.status).toBe(401)
  })

  it('returns 404 when payout method not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    payoutMethodFindFirst.mockResolvedValue(null)
    const { PATCH } = await import('@/app/api/routes-d/payout-methods/[id]/default/route')
    const res = await PATCH(patchReq(), PARAMS)
    expect(res.status).toBe(404)
  })

  it('returns 409 when method is already the default', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    payoutMethodFindFirst.mockResolvedValue({ id: 'pm_1', isDefault: true })
    const { PATCH } = await import('@/app/api/routes-d/payout-methods/[id]/default/route')
    const res = await PATCH(patchReq(), PARAMS)
    expect(res.status).toBe(409)
  })

  it('sets method as default and returns updated record', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    payoutMethodFindFirst.mockResolvedValue({ id: 'pm_1', isDefault: false })
    prismaTransaction.mockResolvedValue([])
    payoutMethodFindUnique.mockResolvedValue({
      id: 'pm_1', type: 'bank', label: 'My Bank', isDefault: true, updatedAt: new Date(),
    })
    const { PATCH } = await import('@/app/api/routes-d/payout-methods/[id]/default/route')
    const res = await PATCH(patchReq(), PARAMS)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.payoutMethod.isDefault).toBe(true)
    expect(body.payoutMethod.id).toBe('pm_1')
  })
})
