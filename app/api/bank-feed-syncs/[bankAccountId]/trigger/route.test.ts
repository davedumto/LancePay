import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockPrisma, mockVerifyAuthToken } = vi.hoisted(() => ({
  mockPrisma: {
    user: {
      findUnique: vi.fn(),
    },
    bankAccount: {
      findUnique: vi.fn(),
    },
    bankFeedSync: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    plaidAccount: {
      updateMany: vi.fn(),
    },
  },
  mockVerifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { POST } from './route'

function makePostRequest(
  bankAccountId: string,
  token: string | null = 'valid-token',
): NextRequest {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest(
    `http://localhost/api/bank-feed-syncs/${bankAccountId}/trigger`,
    { method: 'POST', headers },
  )
}

describe('POST /api/bank-feed-syncs/[bankAccountId]/trigger', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'privy-1' })
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1' })
    mockPrisma.plaidAccount.updateMany.mockResolvedValue({ count: 1 })
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await POST(makePostRequest('ba-1', null), {
      params: { bankAccountId: 'ba-1' },
    })
    expect(res.status).toBe(401)
  })

  it('returns 404 when bank account does not exist and 403 when owned by another user', async () => {
    mockPrisma.bankAccount.findUnique.mockResolvedValueOnce(null)
    const res404 = await POST(makePostRequest('ba-missing'), {
      params: { bankAccountId: 'ba-missing' },
    })
    expect(res404.status).toBe(404)

    mockPrisma.bankAccount.findUnique.mockResolvedValueOnce({
      id: 'ba-other',
      userId: 'user-2',
      bankName: 'Chase',
    })
    const res403 = await POST(makePostRequest('ba-other'), {
      params: { bankAccountId: 'ba-other' },
    })
    expect(res403.status).toBe(403)
  })

  it('returns 409 when a sync is already in progress for the bank account', async () => {
    mockPrisma.bankAccount.findUnique.mockResolvedValueOnce({
      id: 'ba-1',
      userId: 'user-1',
      bankName: 'Chase',
    })
    mockPrisma.bankFeedSync.findUnique.mockResolvedValueOnce({
      id: 'sync-1',
      userId: 'user-1',
      bankAccountId: 'ba-1',
      status: 'syncing',
    })

    const res = await POST(makePostRequest('ba-1'), {
      params: { bankAccountId: 'ba-1' },
    })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('SYNC_IN_PROGRESS')
    expect(mockPrisma.bankFeedSync.update).not.toHaveBeenCalled()
    expect(mockPrisma.bankFeedSync.create).not.toHaveBeenCalled()
  })

  it('updates the existing BankFeedSync row without creating duplicates and completes sync', async () => {
    mockPrisma.bankAccount.findUnique.mockResolvedValueOnce({
      id: 'ba-1',
      userId: 'user-1',
      bankName: 'Chase',
    })
    mockPrisma.bankFeedSync.findUnique.mockResolvedValueOnce({
      id: 'sync-1',
      userId: 'user-1',
      bankAccountId: 'ba-1',
      status: 'idle',
      lastError: 'previous transient error',
    })
    mockPrisma.bankFeedSync.update
      .mockResolvedValueOnce({
        id: 'sync-1',
        userId: 'user-1',
        bankAccountId: 'ba-1',
        status: 'syncing',
        lastError: null,
      })
      .mockResolvedValueOnce({
        id: 'sync-1',
        userId: 'user-1',
        bankAccountId: 'ba-1',
        status: 'idle',
        lastSyncedAt: new Date('2026-03-01T12:00:00Z'),
        lastError: null,
      })

    const res = await POST(makePostRequest('ba-1'), {
      params: { bankAccountId: 'ba-1' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(mockPrisma.bankFeedSync.create).not.toHaveBeenCalled()
    expect(mockPrisma.bankFeedSync.update).toHaveBeenCalledTimes(2)
    expect(mockPrisma.bankFeedSync.update).toHaveBeenNthCalledWith(1, {
      where: { bankAccountId: 'ba-1' },
      data: { status: 'syncing', lastError: null },
    })
    expect(body.status).toBe('idle')
    expect(body.lastError).toBeNull()
  })

  it('records lastError and transitions status to error if sync fails mid-flight', async () => {
    mockPrisma.bankAccount.findUnique.mockResolvedValueOnce({
      id: 'ba-1',
      userId: 'user-1',
      bankName: 'Chase',
    })
    mockPrisma.bankFeedSync.findUnique.mockResolvedValueOnce({
      id: 'sync-1',
      userId: 'user-1',
      bankAccountId: 'ba-1',
      status: 'idle',
    })
    mockPrisma.bankFeedSync.update
      .mockResolvedValueOnce({
        id: 'sync-1',
        userId: 'user-1',
        bankAccountId: 'ba-1',
        status: 'syncing',
        lastError: null,
      })
      .mockResolvedValueOnce({
        id: 'sync-1',
        userId: 'user-1',
        bankAccountId: 'ba-1',
        status: 'error',
        lastError: 'Upstream Plaid institution timeout',
      })
    mockPrisma.plaidAccount.updateMany.mockRejectedValueOnce(
      new Error('Upstream Plaid institution timeout'),
    )

    const res = await POST(makePostRequest('ba-1'), {
      params: { bankAccountId: 'ba-1' },
    })
    expect(res.status).toBe(502)
    const body = await res.json()

    expect(body.status).toBe('error')
    expect(body.lastError).toBe('Upstream Plaid institution timeout')
    expect(mockPrisma.bankFeedSync.update).toHaveBeenLastCalledWith({
      where: { bankAccountId: 'ba-1' },
      data: {
        status: 'error',
        lastError: 'Upstream Plaid institution timeout',
      },
    })
  })
})
