import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockPrisma, mockVerifyAuthToken } = vi.hoisted(() => {
  const txClient = {
    user: { findUnique: vi.fn() },
    plaidAccount: {
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    bankAccount: {
      findMany: vi.fn(),
    },
    bankFeedSync: {
      deleteMany: vi.fn(),
    },
  }
  return {
    mockPrisma: {
      ...txClient,
      $transaction: vi.fn((cb: (tx: typeof txClient) => unknown) => cb(txClient)),
    },
    mockVerifyAuthToken: vi.fn(),
  }
})

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { DELETE } from './route'

function makeDeleteRequest(id: string, token: string | null = 'valid-token'): NextRequest {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest(`http://localhost/api/integrations/plaid/accounts/${id}`, {
    method: 'DELETE',
    headers,
  })
}

describe('DELETE /api/integrations/plaid/accounts/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'privy-user-1' })
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1' })
    mockPrisma.bankAccount.findMany.mockResolvedValue([])
    mockPrisma.bankFeedSync.deleteMany.mockResolvedValue({ count: 0 })
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await DELETE(makeDeleteRequest('pa-1', null), { params: { id: 'pa-1' } })
    expect(res.status).toBe(401)
  })

  it('returns 404 when Plaid account does not exist or is already unlinked', async () => {
    mockPrisma.plaidAccount.findUnique.mockResolvedValueOnce(null)
    const resMissing = await DELETE(makeDeleteRequest('pa-missing'), {
      params: { id: 'pa-missing' },
    })
    expect(resMissing.status).toBe(404)

    mockPrisma.plaidAccount.findUnique.mockResolvedValueOnce({
      id: 'pa-unlinked',
      userId: 'user-1',
      plaidAccountId: 'plaid_acc_1',
      status: 'unlinked',
    })
    const resAlreadyUnlinked = await DELETE(makeDeleteRequest('pa-unlinked'), {
      params: { id: 'pa-unlinked' },
    })
    expect(resAlreadyUnlinked.status).toBe(404)
  })

  it('returns 403 when user attempts to unlink another user Plaid account', async () => {
    mockPrisma.plaidAccount.findUnique.mockResolvedValueOnce({
      id: 'pa-other',
      userId: 'user-2',
      plaidAccountId: 'plaid_acc_2',
      institutionName: 'Chase',
      accountName: 'Checking',
      mask: '4321',
      status: 'active',
    })

    const res = await DELETE(makeDeleteRequest('pa-other'), {
      params: { id: 'pa-other' },
    })
    expect(res.status).toBe(403)
    expect(mockPrisma.plaidAccount.delete).not.toHaveBeenCalled()
  })

  it('unlinks the Plaid account and removes associated BankFeedSync rows', async () => {
    mockPrisma.plaidAccount.findUnique.mockResolvedValueOnce({
      id: 'pa-1',
      userId: 'user-1',
      plaidItemId: 'item-1',
      plaidAccountId: 'plaid_acc_1',
      institutionName: 'Chase',
      accountName: 'Business Checking',
      mask: '1234',
      type: 'depository',
      subtype: 'checking',
      status: 'active',
    })
    mockPrisma.bankAccount.findMany.mockResolvedValueOnce([{ id: 'ba-1' }])
    mockPrisma.bankFeedSync.deleteMany.mockResolvedValueOnce({ count: 1 })
    mockPrisma.plaidAccount.delete.mockResolvedValueOnce({
      id: 'pa-1',
      plaidAccountId: 'plaid_acc_1',
    })

    const res = await DELETE(makeDeleteRequest('pa-1'), { params: { id: 'pa-1' } })
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body).toEqual({
      success: true,
      unlinked: true,
      id: 'pa-1',
      plaidAccountId: 'plaid_acc_1',
      removedBankFeedSyncs: 1,
    })
    expect(mockPrisma.bankFeedSync.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        bankAccountId: { in: expect.arrayContaining(['pa-1', 'plaid_acc_1', 'ba-1']) },
      },
    })
    expect(mockPrisma.plaidAccount.delete).toHaveBeenCalledWith({
      where: { id: 'pa-1' },
    })
  })
})
